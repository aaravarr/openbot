/**
 * Byte-mode QR (versions 1–5, ECC L). Enough for a trycloudflare URL.
 * Single-block versions only, so Reed-Solomon needs no interleave.
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
  let gen = new Uint8Array([1]);
  for (let i = 0; i < ec; i += 1) {
    const next = new Uint8Array(gen.length + 1);
    for (let j = 0; j < gen.length; j += 1) {
      const coef = gen[j] ?? 0;
      next[j] = (next[j] ?? 0) ^ gfMul(coef, GF_EXP[i] ?? 0);
      next[j + 1] = (next[j + 1] ?? 0) ^ coef;
    }
    gen = next;
  }
  return gen;
}

function rsEncode(data: Uint8Array, ec: number): Uint8Array {
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

type Ver = { size: number; data: number; ec: number; align: readonly number[] };

/** Versions 1–5 ECC L are one RS block. */
const VERSIONS: readonly Ver[] = [
  { size: 21, data: 19, ec: 7, align: [] },
  { size: 25, data: 34, ec: 10, align: [18] },
  { size: 29, data: 55, ec: 15, align: [22] },
  { size: 33, data: 80, ec: 20, align: [26] },
  { size: 37, data: 108, ec: 26, align: [30] },
];

function bitsToBytes(bits: number[]): Uint8Array {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i]) {
      bytes[i >> 3] = (bytes[i >> 3] ?? 0) | (0x80 >> (i & 7));
    }
  }
  return bytes;
}

function encodeBytes(text: string, dataCodewords: number): Uint8Array | undefined {
  const payload = new TextEncoder().encode(text);
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i -= 1) {
      bits.push((value >> i) & 1);
    }
  };
  push(0b0100, 4);
  push(payload.length, 8);
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

function alignmentDark(r: number, c: number, centers: readonly number[], size: number): boolean {
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

function reserved(r: number, c: number, size: number, align: readonly number[]): boolean {
  if (inFinder(r, c, size)) {
    return true;
  }
  if (r === 6 || c === 6) {
    return true;
  }
  return align.length > 0 && alignmentDark(r, c, align, size);
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
    default:
      return (r * c) % 2 + (r * c) % 3 === 0;
  }
}

function formatBits(mask: number): number {
  const data = (1 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) {
    rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function writeFormat(grid: boolean[][], size: number, bits: number): void {
  const dark = (i: number) => ((bits >> i) & 1) === 1;
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
  for (let i = 0; i < 8; i += 1) {
    set(size - 1 - i, 8, i);
  }
  for (let i = 8; i < 15; i += 1) {
    set(8, size - 15 + i, i);
  }
}

function place(size: number, code: Uint8Array, mask: number, align: readonly number[]): boolean[][] {
  const grid: boolean[][] = Array.from({ length: size }, () => Array.from({ length: size }, () => false));
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
  for (let i = 0; i < size; i += 1) {
    if (!inFinder(6, i, size)) {
      set(6, i, i % 2 === 0);
    }
    if (!inFinder(i, 6, size)) {
      set(i, 6, i % 2 === 0);
    }
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
        if (reserved(r, c, size, align)) {
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
  writeFormat(grid, size, formatBits(mask));
  return grid;
}

export function qrMatrix(text: string): boolean[][] {
  let ver: Ver | undefined;
  let data: Uint8Array | undefined;
  for (const candidate of VERSIONS) {
    const encoded = encodeBytes(text, candidate.data);
    if (encoded) {
      ver = candidate;
      data = encoded;
      break;
    }
  }
  if (!ver || !data) {
    throw new Error("OpenBot: URL is too long for a QR code");
  }
  const code = rsEncode(data, ver.ec);
  return place(ver.size, code, 0, ver.align);
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
  const padded = qrWithQuietZone(matrix, 2);
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
        line += "█";
      } else if (a) {
        line += "▀";
      } else if (b) {
        line += "▄";
      } else {
        line += " ";
      }
    }
    lines.push(line);
  }
  return lines.join("\n");
}
