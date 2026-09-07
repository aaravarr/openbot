import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_ECC,
  encodeDataCodewords,
  formatBits,
  maskPenalty,
  maskScoreFor,
  qrDetails,
  qrMatrix,
  qrWithQuietZone,
  renderQrAscii,
  rsEncode,
  versionBits,
  type EccLevel,
} from "./qrcode.ts";

function finderAt(matrix: boolean[][], originR: number, originC: number): void {
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 7; c += 1) {
      const expected =
        r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
      assert.equal(
        matrix[originR + r]?.[originC + c],
        expected,
        `finder ${String(originR)},${String(originC)} cell ${String(r)},${String(c)}`,
      );
    }
  }
}

/** Reads the top-left format copy MSB-first: (8,0) holds bit 14. */
function readFormatBits(matrix: boolean[][], size: number): number {
  const cells: Array<[number, number]> = [];
  for (let c = 0; c <= 5; c += 1) cells.push([8, c]);
  cells.push([8, 7], [8, 8], [7, 8]);
  for (let r = 5; r >= 0; r -= 1) cells.push([r, 8]);
  let value = 0;
  for (const [r, c] of cells) value = (value << 1) | (matrix[r]?.[c] === true ? 1 : 0);
  return value;
}

/** Reads the top-right version block LSB-first: bit i lives at row i/3. */
function readVersionBits(matrix: boolean[][], size: number): number {
  let value = 0;
  for (let i = 0; i < 18; i += 1) {
    const a = Math.floor(i / 3);
    const b = size - 11 + (i % 3);
    if (matrix[a]?.[b] === true) value |= 1 << i;
  }
  return value;
}

/** Independent BCH check: an 18-bit version codeword must divide 0x1F25 evenly. */
function isValidVersionCodeword(bits: number): boolean {
  let rest = bits;
  for (let i = 17; i >= 12; i -= 1) {
    if ((rest >> i) & 1) rest ^= 0x1f25 << (i - 12);
  }
  return (rest & 0xfff) === 0;
}

function toRows(matrix: boolean[][]): string[] {
  return matrix.map((row) => row.map((cell) => (cell ? "1" : "0")).join(""));}


test("qr matrix is square with three finder patterns", () => {
  const matrix = qrMatrix("https://openbot-test.trycloudflare.com");
  const size = matrix.length;
  assert.ok(size >= 21);
  assert.equal(matrix[0]?.length, size);
  finderAt(matrix, 0, 0);
  finderAt(matrix, 0, size - 7);
  finderAt(matrix, size - 7, 0);
});


test("renderQrAscii returns a block drawing", () => {
  const ascii = renderQrAscii("https://openbot-test.trycloudflare.com");
  assert.match(ascii, /[\u2588\u2580\u2584]/);
  const lines = ascii.split("\n");
  assert.ok(lines.length >= 10);
  assert.equal(new Set(lines.map((line) => line.length)).size, 1);
});


test("qrWithQuietZone pads four light modules by default", () => {
  const matrix = qrMatrix("https://openbot-test.trycloudflare.com");
  const padded = qrWithQuietZone(matrix);
  assert.equal(padded.length, matrix.length + 8);
  assert.equal(padded[0]?.length, matrix.length + 8);
  for (let i = 0; i < 4; i += 1) {
    assert.equal(padded[0]?.[i], false);
    assert.equal(padded[i]?.[0], false);
    assert.equal(padded[padded.length - 1]?.[i], false);
  }
  finderAt(padded, 4, 4);
});


test("default error correction level is M", () => {
  assert.equal(DEFAULT_ECC, "M");
  assert.deepEqual(qrMatrix("Hello, World!"), qrMatrix("Hello, World!", "M"));
});


test("reed-solomon matches the thonky reference vector", () => {
  // Thonky QR tutorial, error-correction coding step for version 1-M:
  // data codewords 32,91,11,...,17 must yield ECC 196,35,39,...,23.
  const data = new Uint8Array([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17]);
  const full = Array.from(rsEncode(data, 10));
  assert.deepEqual(full.slice(0, 16), Array.from(data));
  assert.deepEqual(full.slice(16), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});


test("format information matches the standard codeword table", () => {
  // MSB-first integers of the published 15-bit format strings, verified
  // against an independent encoder for all 4 levels x 8 masks.
  const table: Record<EccLevel, number[]> = {
    L: [0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976],
    M: [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0],
    Q: [0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed],
    H: [0x1689, 0x13be, 0x1ce7, 0x19d0, 0x0762, 0x0255, 0x0d0c, 0x083b],
  };
  for (const level of ["L", "M", "Q", "H"] as const) {
    for (let mask = 0; mask < 8; mask += 1) {
      assert.equal(formatBits(level, mask), table[level]?.[mask], `${level} mask ${String(mask)}`);
    }
  }
});


test("version information spots a known codeword and valid BCH", () => {
  assert.equal(versionBits(7), 0x7c94);
  for (let v = 7; v <= 10; v += 1) assert.ok(isValidVersionCodeword(versionBits(v)), `version ${String(v)}`);
});


test("byte mode uses an 8-bit length for v1-9 and 16-bit for v10", () => {
  const short = encodeDataCodewords("AB", 20, 9);
  assert.ok(short);
  // mode 0100, count 2, then payload: 0100 00000010 01000001 01000010 ...
  assert.equal(short[0], 0x40);
  assert.equal(short[1], 0x24);
  const v10 = encodeDataCodewords("AB", 20, 10);
  assert.ok(v10);
  // mode 0100, 16-bit count 2: 0100 00000000 00000010 ...
  assert.equal(v10[0], 0x40);
  assert.equal(v10[1], 0x00);
  assert.equal(v10[2], 0x24);
});


test("version 1-M byte matrix matches the independent reference", () => {
  // Byte-for-byte output of Nayuki qrcodegen for QrSegment.make_bytes(b"Hello, World!"), Ecc.MEDIUM.
  const expected = [
    "111111101001001111111",
    "100000101100001000001",
    "101110100101001011101",
    "101110101101001011101",
    "101110100111001011101",
    "100000100101101000001",
    "111111101010101111111",
    "000000001101100000000",
    "101101110101101001011",
    "001011011100110001101",
    "110010100111010100011",
    "101000001111000011010",
    "101101100010101100001",
    "000000001011110010101",
    "111111101110001010000",
    "100000101110110101110",
    "101110100110010111110",
    "101110101000110001110",
    "101110101001101100100",
    "100000100011011110001",
    "111111101011111100100",
  ];
  const details = qrDetails("Hello, World!", "M");
  assert.equal(details.version, 1);
  assert.equal(details.size, 21);
  assert.equal(details.mask, 3);
  assert.deepEqual(toRows(details.matrix), expected);
  assert.equal(readFormatBits(details.matrix, 21), formatBits("M", details.mask));
  // Timing crosses the finder boxes: (6,8) and (8,6) stay dark.
  assert.equal(details.matrix[6]?.[8], true);
  assert.equal(details.matrix[8]?.[6], true);
});


test("version 2 matrix carries its alignment pattern", () => {
  const expected = [
    "1111111000101111001111111",
    "1000001000101111101000001",
    "1011101010110101001011101",
    "1011101010010011001011101",
    "1011101010111001101011101",
    "1000001010100000001000001",
    "1111111010101010101111111",
    "0000000010110010100000000",
    "1011111001001000001111100",
    "1100000111001111000101000",
    "1010011111001111101100011",
    "0001000100000101011000011",
    "1010011001001011011011101",
    "1001100001000000100101000",
    "1010111000111001101100011",
    "1011100011010011011000011",
    "1001001010110001111111101",
    "0000000011101111100011000",
    "1111111000100110101010011",
    "1000001010101100100010010",
    "1011101011001011111111110",
    "1011101011000000011011001",
    "1011101011011001000100001",
    "1000001000010011101100001",
    "1111111010110000011001111",
  ];
  const details = qrDetails("a".repeat(15), "M");
  assert.equal(details.version, 2);
  assert.equal(details.size, 25);
  assert.deepEqual(toRows(details.matrix), expected);
  // Alignment center is dark while its inner ring stays light.
  assert.equal(details.matrix[18]?.[18], true);
  assert.equal(details.matrix[17]?.[18], false);
});


test("version 5-Q matrix interleaves four blocks with a remainder", () => {
  // Independent reference matrix (multi-block short-first interleave,
  // remainder 134 % 4 = 2, alignment at 30).
  const expected = [
    "1111111010000111101000110011001111111",
    "1000001000011101011001111001001000001",
    "1011101011001101111100011010101011101",
    "1011101010100100101100110011001011101",
    "1011101001010101010100010111101011101",
    "1000001011111110101111001111101000001",
    "1111111010101010101010101010101111111",
    "0000000010010001100001010011100000000",
    "0101011110110000101011011110111101101",
    "1011110101000110001111001100111001011",
    "0001011011000111001000000110101011011",
    "1010100000100101110001100101010110010",
    "1001111110010111001111001100111000001",
    "1110110010010100011101101000011101111",
    "0101111100010001111000110000011101101",
    "0111110000010101001111110111000100000",
    "0011011110110000000001101000011100101",
    "1001000000011000000101011110101011001",
    "1001101111111101001000100010001111111",
    "0110100000001110000101010011100000110",
    "1011001011110010110011011110101010000",
    "1010010100011100011111001100111001011",
    "1001011010110011000010000110101011011",
    "1011010010100100011001100101010110010",
    "0011111101111001010001001100111000001",
    "0011010011000000110101101000011101111",
    "1010111001100101110110110000011101101",
    "0101100100100010100111110111000100000",
    "1110011111101101010011101000111110101",
    "0000000010101000001001011111100011001",
    "1111111011001010010100100011101011111",
    "1000001011011110111011010010100010100",
    "1011101001000111010101011110111110011",
    "1011101011000000010101001100000111001",
    "1011101000101111100100000110000011001",
    "1000001010100000110111100101100010000",
    "1111111000010010111011001101111010011",
  ];
  const details = qrDetails("a".repeat(60), "Q");
  assert.equal(details.version, 5);
  assert.equal(details.size, 37);
  assert.equal(details.mask, 7);
  assert.deepEqual(toRows(details.matrix), expected);
});


test("version 7 carries version information and two alignments per side", () => {
  const details = qrDetails("a".repeat(110), "M");
  assert.equal(details.version, 7);
  assert.equal(details.size, 45);
  assert.equal(readVersionBits(details.matrix, 45), versionBits(7));
  assert.equal(readFormatBits(details.matrix, 45), formatBits("M", details.mask));
  for (const [r, c] of [[22, 22], [22, 38], [38, 22], [38, 38], [6, 22], [22, 6]] as const) {
    assert.equal(details.matrix[r]?.[c], true, `alignment ${String(r)},${String(c)}`);
  }
});


test("version 10 uses the 16-bit byte length", () => {
  const details = qrDetails("a".repeat(200), "M");
  assert.equal(details.version, 10);
  assert.equal(details.size, 57);
  assert.equal(readVersionBits(details.matrix, 57), versionBits(10));
});


test("payload size bumps the version at the v1/v2 boundary", () => {
  assert.equal(qrDetails("a".repeat(14), "M").size, 21);
  assert.equal(qrDetails("a".repeat(15), "M").size, 25);
});


test("mask choice is the lowest-penalty mask", () => {
  const cases: Array<{ text: string; ecc: EccLevel }> = [
    { text: "Hello, World!", ecc: "M" },
    { text: "https://openbot-test.trycloudflare.com", ecc: "M" },
    { text: "a".repeat(60), ecc: "Q" },
    { text: "a".repeat(110), ecc: "M" },
  ];
  for (const { text, ecc } of cases) {
    let best = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let mask = 0; mask < 8; mask += 1) {
      const score = maskScoreFor(text, mask, ecc);
      if (score < bestScore) {
        bestScore = score;
        best = mask;
      }
    }
    assert.equal(qrDetails(text, ecc).mask, best, text.slice(0, 12));
  }
});


test("mask penalty follows N1-N4 on hand-computed patterns", () => {
  const size = 21;
  const blank = (value: boolean): boolean[][] =>
    Array.from({ length: size }, () => Array.from({ length: size }, () => value));
  const light = blank(false);
  const dark = blank(true);
  // N1 19 per line x 42 lines + N2 400 blocks x 3 + N4 k=9 x 10.
  assert.equal(maskPenalty(light), 2088);
  assert.equal(maskPenalty(dark), 2088);
  const single = blank(false);
  (single[10] as boolean[])[10] = true;
  assert.equal(maskPenalty(single), 2070);
  const checker = Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => (r + c) % 2 === 0));
  assert.equal(maskPenalty(checker), 0);
  // Finder-like 1:1:3:1:1 run with light on both sides. The reference
  // counter credits both orientations, hence two N3 hits on top of the
  // run/block deltas.
  const finderLike = blank(false);
  const core = [true, false, true, true, true, false, true];
  for (let c = 4; c <= 10; c += 1) (finderLike[10] as boolean[])[c] = core[c - 4] === true;
  assert.equal(maskPenalty(finderLike), 2094);
});
