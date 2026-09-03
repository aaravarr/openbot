import assert from "node:assert/strict";
import test from "node:test";
import { qrMatrix, qrWithQuietZone, renderQrAscii } from "./qrcode.ts";

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
  assert.match(ascii, /[█▀▄]/);
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
