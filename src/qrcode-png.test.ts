import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { qrMatrix, qrWithQuietZone } from "./qrcode.ts";
import { pngChunkCrc, qrPngBytes } from "./qrcode-png.ts";

test("QR PNG has valid signature, IHDR, CRCs, and exact QR pixels", () => {
  const text = "https://openbot-test.trycloudflare.com";
  const png = qrPngBytes(text, 2);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let compressed: Uint8Array<ArrayBufferLike> = new Uint8Array();
  while (at < png.length) {
    const length = view.getUint32(at);
    const type = new TextDecoder().decode(png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    const body = png.subarray(at + 4, at + 8 + length);
    assert.equal(view.getUint32(at + 8 + length), pngChunkCrc(body));
    if (type === "IHDR") {
      width = new DataView(data.buffer, data.byteOffset).getUint32(0);
      height = new DataView(data.buffer, data.byteOffset).getUint32(4);
      assert.equal(data[8], 8);
      assert.equal(data[9], 0);
    }
    if (type === "IDAT") compressed = data;
    at += 12 + length;
  }
  const expected = qrWithQuietZone(qrMatrix(text), 4);
  assert.equal(width, expected.length * 2);
  assert.equal(height, width);
  const raw = inflateSync(compressed);
  for (let y = 0; y < height; y += 1) {
    assert.equal(raw[y * (width + 1)], 0);
    for (let x = 0; x < width; x += 1) {
      const expectedPixel = expected[Math.floor(y / 2)]?.[Math.floor(x / 2)] ? 0 : 255;
      assert.equal(raw[y * (width + 1) + 1 + x], expectedPixel);
    }
  }
});
