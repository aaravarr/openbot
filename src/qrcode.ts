/**
 * Byte-mode QR generator (versions 1-10) with zero dependencies.
 *
 * Follows ISO/IEC 18004 Model 2:
 * - Auto-selects the smallest version that fits the payload.
 * - Default error correction level is M (15% recovery).
 * - Multi-block Reed-Solomon with codeword interleaving for versions >= 5.
 * - Format information (BCH 0x537, XOR mask 0x5412) and version information
 *   (BCH 0x1F25) for versions 7+.
 * - Evaluates all 8 mask patterns with ISO penalty rules N1-N4 and picks the
 *   lowest-scoring one.
 */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

function initGf(): void {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x *= 2;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255] ?? 0;
  }
}
initGf();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0;
  }
  return GF_EXP[(GF_LOG[a] ?? 0) + (GF_LOG[b] ?? 0)] ?? 0;
}

function rsGenerator(ec: number): Uint8Array {
  // Coefficients are stored highest-degree first: gen[0] is the leading 1.
  // Multiplying by (x + a) keeps that order, so the division in rsEncode
  // can cancel each leading term with gen[0] === 1.
  let gen = new Uint8Array([1]);
  for (let i = 0; i < ec; i += 1) {
    const next = new Uint8Array(gen.length + 1);
    for (let j = 0; j < gen.length; j += 1) {
      const coef = gen[j] ?? 0;
      next[j] = (next[j] ?? 0) ^ coef;
      next[j + 1] = (next[j + 1] ?? 0) ^ gfMul(coef, GF_EXP[i] ?? 0);
    }
    gen = next;
  }
  return gen;
}

/** Appends Reed-Solomon ECC codewords; exported for reference-vector checks. */
export function rsEncode(data: Uint8Array, ec: number): Uint8Array {
  const gen = rsGenerator(ec);
  const out = new Uint8Array(data.length + ec);
  out.set(data);
  for (let i = 0; i < data.length; i += 1) {
    const coef = out[i] ?? 0;
    if (coef === 0) {
      continue;
    }
    for (let j = 0; j < gen.length; j += 1) {
      out[i + j] = (out[i + j] ?? 0) ^ gfMul(gen[j] ?? 0, coef);
    }
  }
  const full = new Uint8Array(data.length + ec);
  full.set(data);
  full.set(out.subarray(data.length), data.length);
  return full;
}

export type EccLevel = "L" | "M" | "Q" | "H";

const ECC_FORMAT_BITS: Record<EccLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };
export const DEFAULT_ECC: EccLevel = "M";

type BlockSpec = { blocks: number; total: number; eccPerBlock: number };
type VersionSpec = {
  version: number;
  size: number;
  align: readonly number[];
  byEcc: Record<EccLevel, { data: number; layout: BlockSpec }>;
};

const ECC_PER_BLOCK: Record<EccLevel, readonly number[]> = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 26, 28],
};

const NUM_BLOCKS: Record<EccLevel, readonly number[]> = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};

// Total codewords per version = floor(getNumRawDataModules(v) / 8).
const RAW_CODEWORDS: readonly number[] = [
  26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
];

// Alignment pattern centers per version (ISO/IEC 18004 Table D.1).
// Versions 7+ carry several patterns; using only size - 7 would drop them
// and corrupt every version 7-10 symbol.
const ALIGNMENT_CENTERS: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

function buildSpecs(): VersionSpec[] {
  const specs: VersionSpec[] = [];
  for (let v = 1; v <= 10; v += 1) {
    const size = v * 4 + 17;
    const align: number[] = [...(ALIGNMENT_CENTERS[v - 1] ?? [])];
    const byEcc = {} as Record<EccLevel, { data: number; layout: BlockSpec }>;
    for (const level of ["L", "M", "Q", "H"] as const) {
      const ecc = ECC_PER_BLOCK[level][v - 1] ?? 0;
      const blocks = NUM_BLOCKS[level][v - 1] ?? 0;
      const raw = RAW_CODEWORDS[v - 1] ?? 0;
      const data = raw - ecc * blocks;
      byEcc[level] = { data, layout: { blocks, total: raw, eccPerBlock: ecc } };
    }
    specs.push({ version: v, size, align, byEcc });
  }
  return specs;
}

const VERSIONS: readonly VersionSpec[] = buildSpecs();

function bitsToBytes(bits: number[]): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i]) {
      bytes[i >> 3] = (bytes[i >> 3] ?? 0) | (0x80 >> (i & 7));
    }
  }
  return bytes;
}

export function encodeDataCodewords(
  text: string,
  dataCodewords: number,
  version = 9,
): Uint8Array | undefined {
  const payload = new TextEncoder().encode(text);
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i -= 1) {
      bits.push((value >> i) & 1);
    }
  };
  push(0b0100, 4);
  // Byte-mode character count indicator: 8 bits for versions 1-9,
  // 16 bits for version 10 and up.
  if (version >= 10) {
    if (payload.length > 65535) {
      return undefined;
    }
    push(payload.length, 16);
  } else {
    if (payload.length > 255) {
      return undefined;
    }
    push(payload.length, 8);
  }
  for (const byte of payload) {
    push(byte, 8);
  }
  const capacity = dataCodewords * 8;
  if (bits.length + 4 <= capacity) {
    push(0, Math.min(4, capacity - bits.length));
  }
  while (bits.length % 8 !== 0 && bits.length < capacity) {
    bits.push(0);
  }
  let pad = 0xec;
  while (bits.length / 8 < dataCodewords) {
    push(pad, 8);
    pad = pad === 0xec ? 0x11 : 0xec;
  }
  if (bits.length / 8 > dataCodewords) {
    return undefined;
  }
  return bitsToBytes(bits.slice(0, capacity));
}

/** Splits data codewords into RS blocks and interleaves them per ISO 18004. */
function interleave(data: Uint8Array, layout: BlockSpec): Uint8Array {
  const { blocks, total, eccPerBlock } = layout;
  if (blocks === 1) {
    return rsEncode(data, eccPerBlock);
  }
  const blockLen = Math.floor(total / blocks);
  const shortLen = blockLen - eccPerBlock;
  const numLong = total % blocks;
  const blockData: Uint8Array[] = [];
  let offset = 0;
  for (let b = 0; b < blocks; b += 1) {
    // ISO 18004 fills short blocks first; the longer blocks (one extra data
    // codeword each) come last. Reversing this order scrambles the
    // interleaved sequence for every multi-block symbol with a remainder.
    const len = shortLen + (b >= blocks - numLong ? 1 : 0);
    blockData.push(rsEncode(data.subarray(offset, offset + len), eccPerBlock));
    offset += len;
  }
  const out = new Uint8Array(total);
  let k = 0;
  // ISO 18004 interleaves in two phases: data codewords first (long blocks
  // contribute one extra data codeword), then the ECC codewords block by
  // block. Mixing both phases in one pass scrambles every symbol whose
  // total codeword count is not divisible by its block count.
  const dataLens = blockData.map((block) => block.length - eccPerBlock);
  const maxData = Math.max(...dataLens);
  for (let i = 0; i < maxData; i += 1) {
    for (let b = 0; b < blocks; b += 1) {
      const block = blockData[b];
      if (block && i < (dataLens[b] ?? 0)) {
        out[k] = block[i] ?? 0;
        k += 1;
      }
    }
  }
  for (let i = 0; i < eccPerBlock; i += 1) {
    for (let b = 0; b < blocks; b += 1) {
      const block = blockData[b];
      const dataLen = dataLens[b] ?? 0;
      if (block) {
        out[k] = block[dataLen + i] ?? 0;
        k += 1;
      }
    }
  }
  return out;
}

function inFinder(r: number, c: number, size: number): boolean {
  return (r < 9 && c < 9) || (r < 9 && c >= size - 8) || (r >= size - 8 && c < 9);
}

function finderDark(r: number, c: number, originR: number, originC: number): boolean {
  const dr = r - originR;
  const dc = c - originC;
  if (dr < 0 || dc < 0 || dr > 6 || dc > 6) {
    return false;
  }
  return dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
}

function inAlignment(r: number, c: number, centers: readonly number[], size: number): boolean {
  for (const ar of centers) {
    for (const ac of centers) {
      if (inFinder(ar, ac, size)) {
        continue;
      }
      const dr = r - ar;
      const dc = c - ac;
      if (Math.abs(dr) <= 2 && Math.abs(dc) <= 2) {
        return true;
      }
    }
  }
  return false;
}

function alignmentDark(r: number, c: number, centers: readonly number[], size: number): boolean {
  if (!inAlignment(r, c, centers, size)) {
    return false;
  }
  for (const ar of centers) {
    for (const ac of centers) {
      if (inFinder(ar, ac, size)) {
        continue;
      }
      const dr = r - ar;
      const dc = c - ac;
      if (Math.abs(dr) <= 2 && Math.abs(dc) <= 2) {
        return Math.max(Math.abs(dr), Math.abs(dc)) === 2 || (dr === 0 && dc === 0);
      }
    }
  }
  return false;
}

function isFunctionModule(
  r: number,
  c: number,
  size: number,
  align: readonly number[],
): boolean {
  if (inFinder(r, c, size)) {
    return true;
  }
  if (r === 6 || c === 6) {
    return true;
  }
  if (align.length > 0 && inAlignment(r, c, align, size)) {
    return true;
  }
  // Version information exists only for versions 7+ (size 45+). Treating
  // these cells as function modules on versions 5-6 would swallow 36 data
  // modules and shift the entire codeword stream.
  if (size >= 45) {
    const nearTopRight = c >= size - 11 && c <= size - 9 && r <= 5;
    const nearBottomLeft = r >= size - 11 && r <= size - 9 && c <= 5;
    if (nearTopRight || nearBottomLeft) {
      return true;
    }
  }
  return false;
}

/** 15-bit format information codeword (BCH with XOR mask 0x5412). */
export function formatBits(level: EccLevel, mask: number): number {
  const data = (ECC_FORMAT_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

/** 18-bit version information codeword for versions 7+. */
export function versionBits(version: number): number {
  let rem = version;
  for (let i = 0; i < 12; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  }
  return (version << 12) | rem;
}

function writeFormat(grid: boolean[][], size: number, bits: number): void {
  // ISO 18004 stores the most significant bit first: position index 0
  // holds bit 14 and position index 14 holds bit 0. Writing them LSB
  // first mirrors the format string and no decoder accepts it.
  const dark = (i: number) => ((bits >> (14 - i)) & 1) === 1;
  const set = (r: number, c: number, i: number) => {
    const row = grid[r];
    if (row) {
      row[c] = dark(i);
    }
  };
  for (let i = 0; i <= 5; i += 1) {
    set(8, i, i);
  }
  set(8, 7, 6);
  set(8, 8, 7);
  set(7, 8, 8);
  for (let i = 9; i < 15; i += 1) {
    set(14 - i, 8, i);
  }
  for (let i = 0; i < 7; i += 1) {
    set(size - 1 - i, 8, i);
  }
  // The horizontal copy spans columns size-8..size-1 (8 modules). Stopping
  // at size-7 drops bit 7 and scanners reject the symbol.
  for (let i = 7; i < 15; i += 1) {
    set(8, size - 15 + i, i);
  }
  const darkRow = grid[size - 8];
  if (darkRow) {
    darkRow[8] = true;
  }
}

function writeVersion(grid: boolean[][], size: number, version: number): void {
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const bit = ((bits >> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const b = size - 11 + (i % 3);
    const rowA = grid[a];
    if (rowA) {
      rowA[b] = bit;
    }
    const rowB = grid[b];
    if (rowB) {
      rowB[a] = bit;
    }
  }
}

function maskBit(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return (r * c) % 2 + (r * c) % 3 === 0;
    case 6:
      return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
    default:
      return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
  }
}

function place(
  size: number,
  code: Uint8Array,
  mask: number,
  align: readonly number[],
): boolean[][] {
  const grid: boolean[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => false),
  );
  const set = (r: number, c: number, dark: boolean) => {
    const row = grid[r];
    if (row) {
      row[c] = dark;
    }
  };
  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (finderDark(r, c, 0, 0) || finderDark(r, c, 0, size - 7) || finderDark(r, c, size - 7, 0)) {
        set(r, c, true);
      }
    }
  }
  // Timing runs between the separators: modules 8..size-9. The 9x9 finder
  // boxes also cover (6, 8) and (8, 6), which are timing modules, so the
  // range check must not reuse inFinder here (it would leave them light).
  for (let i = 8; i < size - 8; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  if (align.length) {
    for (let r = 0; r < size; r += 1) {
      for (let c = 0; c < size; c += 1) {
        if (!inFinder(r, c, size) && alignmentDark(r, c, align, size)) {
          set(r, c, true);
        }
      }
    }
  }
  set(size - 8, 8, true);
  let bit = 0;
  const totalBits = code.length * 8;
  let dir = -1;
  let col = size - 1;
  while (col > 0) {
    if (col === 6) {
      col -= 1;
    }
    for (let i = 0; i < size; i += 1) {
      const r = dir < 0 ? size - 1 - i : i;
      for (let dc = 0; dc < 2; dc += 1) {
        const c = col - dc;
        if (isFunctionModule(r, c, size, align)) {
          continue;
        }
        let dark = false;
        if (bit < totalBits) {
          const byte = code[bit >> 3] ?? 0;
          dark = ((byte >> (7 - (bit & 7))) & 1) === 1;
          bit += 1;
        }
        if (maskBit(mask, r, c)) {
          dark = !dark;
        }
        set(r, c, dark);
      }
    }
    dir *= -1;
    col -= 2;
  }
  return grid;
}

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

function runPenalty(
  get: (i: number) => boolean,
  length: number,
  size: number,
): number {
  let score = 0;
  let runColor = false;
  let runLen = 0;
  const history: number[] = [0, 0, 0, 0, 0, 0, 0];
  const finderPenaltyCount = () => {
    const n = history[1] ?? 0;
    const core =
      n > 0 &&
      history[2] === n &&
      history[3] === n * 3 &&
      history[4] === n &&
      history[5] === n;
    let count = 0;
    if (core && (history[0] ?? 0) >= n * 4 && (history[6] ?? 0) >= n) {
      count += 1;
    }
    if (core && (history[6] ?? 0) >= n * 4 && (history[0] ?? 0) >= n) {
      count += 1;
    }
    return count;
  };
  const addHistory = (len: number) => {
    if ((history[0] ?? 0) === 0) {
      len += size;
    }
    history.pop();
    history.unshift(len);
  };
  for (let i = 0; i < length; i += 1) {
    const color = get(i);
    if (color === runColor) {
      runLen += 1;
      if (runLen === 5) {
        score += PENALTY_N1;
      } else if (runLen > 5) {
        score += 1;
      }
    } else {
      addHistory(runLen);
      if (!runColor) {
        score += finderPenaltyCount() * PENALTY_N3;
      }
      runColor = color;
      runLen = 1;
    }
  }
  if (runColor) {
    addHistory(runLen);
    runLen = 0;
  }
  runLen += size;
  addHistory(runLen);
  score += finderPenaltyCount() * PENALTY_N3;
  return score;
}

export function maskPenalty(matrix: boolean[][]): number {
  const size = matrix.length;
  let score = 0;
  for (let r = 0; r < size; r += 1) {
    score += runPenalty((c) => matrix[r]?.[c] === true, size, size);
  }
  for (let c = 0; c < size; c += 1) {
    score += runPenalty((r) => matrix[r]?.[c] === true, size, size);
  }
  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const color = matrix[r]?.[c] === true;
      if (
        color === (matrix[r]?.[c + 1] === true) &&
        color === (matrix[r + 1]?.[c] === true) &&
        color === (matrix[r + 1]?.[c + 1] === true)
      ) {
        score += PENALTY_N2;
      }
    }
  }
  let dark = 0;
  for (const row of matrix) {
    for (const cell of row) {
      if (cell) {
        dark += 1;
      }
    }
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += k * PENALTY_N4;
  return score;
}

function selectVersion(
  text: string,
  ecc: EccLevel,
): { spec: VersionSpec; code: Uint8Array } {
  let chosen: { spec: VersionSpec; code: Uint8Array } | undefined;
  for (const spec of VERSIONS) {
    const encoded = encodeDataCodewords(text, spec.byEcc[ecc].data, spec.version);
    if (encoded) {
      chosen = { spec, code: interleave(encoded, spec.byEcc[ecc].layout) };
      break;
    }
  }
  if (!chosen) {
    throw new Error("OpenBot: URL is too long for a QR code");
  }
  return chosen;
}

export interface QrDetails {
  version: number;
  size: number;
  mask: number;
  matrix: boolean[][];
}

/** Full encode result including the selected version and mask. */
export function qrDetails(text: string, ecc: EccLevel = DEFAULT_ECC): QrDetails {
  const { spec, code } = selectVersion(text, ecc);
  let best: boolean[][] | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  let bestMask = 0;
  for (let mask = 0; mask < 8; mask += 1) {
    const grid = place(spec.size, code, mask, spec.align);
    // Score the final symbol: version and format information are part of
    // what a scanner sees, so they participate in mask evaluation.
    if (spec.version >= 7) {
      writeVersion(grid, spec.size, spec.version);
    }
    writeFormat(grid, spec.size, formatBits(ecc, mask));
    const score = maskPenalty(grid);
    if (score < bestScore) {
      bestScore = score;
      best = grid;
      bestMask = mask;
    }
  }
  if (!best) {
    throw new Error("OpenBot: QR mask selection failed");
  }
  return { version: spec.version, size: spec.size, mask: bestMask, matrix: best };
}

export function qrMatrix(text: string, ecc: EccLevel = DEFAULT_ECC): boolean[][] {
  return qrDetails(text, ecc).matrix;
}

/**
 * Penalty score the encoder would assign to a given mask (evaluated on the
 * final grid with version and format information, exactly as during mask
 * selection).
 */
export function maskScoreFor(
  text: string,
  mask: number,
  ecc: EccLevel = DEFAULT_ECC,
): number {
  const { spec, code } = selectVersion(text, ecc);
  const grid = place(spec.size, code, mask, spec.align);
  if (spec.version >= 7) {
    writeVersion(grid, spec.size, spec.version);
  }
  writeFormat(grid, spec.size, formatBits(ecc, mask));
  return maskPenalty(grid);
}

export function qrWithQuietZone(matrix: boolean[][], quiet = 4): boolean[][] {
  if (quiet < 0) {
    throw new Error("OpenBot: QR quiet zone must be non-negative");
  }
  const inner = matrix[0]?.length ?? 0;
  const size = inner + quiet * 2;
  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => Boolean(matrix[r - quiet]?.[c - quiet])),
  );
}

export function renderQrAscii(text: string): string {
  const matrix = qrMatrix(text);
  const padded = qrWithQuietZone(matrix, 4);
  const size = padded[0]?.length ?? 0;
  const lines: string[] = [];
  for (let r = 0; r < padded.length; r += 2) {
    let line = "";
    const top = padded[r] ?? [];
    const bottom = padded[r + 1] ?? [];
    for (let c = 0; c < size; c += 1) {
      const a = top[c] === true;
      const b = bottom[c] === true;
      if (a && b) {
        line += "\u2588";
      } else if (a) {
        line += "\u2580";
      } else if (b) {
        line += "\u2584";
      } else {
        line += " ";
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}
