import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const imageRead = require(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/image-read.cjs")) as {
  prepareImageForModel: (
    buffer: Buffer,
    mime: string,
    options?: { quality?: number; maxEdge?: number; convert?: unknown },
  ) => Promise<{ buffer: Buffer; mime: string }>;
  enforceImageBudget: (messages: unknown, options?: { budget?: number; convert?: unknown }) => Promise<unknown[]>;
  dataUrlFromBuffer: (buffer: Buffer, mime: string) => string;
  MAX_REQUEST_MESSAGE_BYTES: number;
  DEFAULT_MAX_EDGE: number;
};

const PNG = (require("pngjs") as { PNG: new (opts: { width: number; height: number }) => { data: Buffer; width: number; height: number } }).PNG;
const pngSyncWrite = (require("pngjs") as { PNG: { sync: { write: (png: unknown) => Buffer } } }).PNG.sync.write;
const jpegjs = require("jpeg-js") as { decode: (buf: Buffer) => { width: number; height: number } };

const WEBP_MAGIC = Buffer.from("RIFF");

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

function noisePng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  const rng = makeRng(0x9e3779b9);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    png.data[o] = rng() & 255;
    png.data[o + 1] = rng() & 255;
    png.data[o + 2] = rng() & 255;
    png.data[o + 3] = 255;
  }
  return pngSyncWrite(png);
}

let largePng: Buffer;
test.before(() => {
  // 2000x1500 noise PNG: >600KB, long edge >1568, incompressible noise.
  largePng = noisePng(2000, 1500);
});

test("a large PNG is re-encoded to a much smaller JPEG with long edge <= 1568", async () => {
  assert.ok(largePng.length > imageRead.MAX_REQUEST_MESSAGE_BYTES / 512);
  const result = await imageRead.prepareImageForModel(largePng, "image/png");
  assert.equal(result.mime, "image/jpeg");
  assert.ok(result.buffer.length < largePng.length / 3, `${result.buffer.length} vs ${largePng.length}`);
  const decoded = jpegjs.decode(result.buffer);
  assert.ok(Math.max(decoded.width, decoded.height) <= imageRead.DEFAULT_MAX_EDGE);
});

test("a small PNG passes through unchanged", async () => {
  const small = noisePng(32, 32);
  const result = await imageRead.prepareImageForModel(small, "image/png");
  assert.equal(result.mime, "image/png");
  assert.equal(result.buffer, small);
});

test("webp without a system converter passes through unchanged", async () => {
  const webp = Buffer.concat([WEBP_MAGIC, Buffer.alloc(700 * 1024, 0x11)]);
  const result = await imageRead.prepareImageForModel(webp, "image/webp", { convert: null });
  assert.equal(result.buffer, webp);
});

test("budget enforcement trims many large images to fit the byte budget", async () => {
  const dataUrl = imageRead.dataUrlFromBuffer(largePng, "image/png");
  const make = () => ({
    role: "user",
    content: [
      { type: "text", text: "look" },
      { type: "image_url", image_url: { url: dataUrl } },
    ],
  });
  const messages = [make(), make(), make(), make()];
  const budget = 150 * 1024;
  const out = await imageRead.enforceImageBudget(messages, { budget, convert: null });

  assert.equal(Array.isArray(out), true);
  const serialized = Buffer.byteLength(JSON.stringify(out), "utf8");
  assert.ok(serialized <= budget, `serialized ${serialized} > budget ${budget}`);
  for (const msg of out as { role: string; content: unknown }[]) {
    assert.equal(typeof msg.role, "string");
    const content = msg.content;
    assert.ok(typeof content === "string" || Array.isArray(content));
  }
});

test("enforceImageBudget leaves non-image content untouched", async () => {
  const messages = [
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
  ];
  const out = await imageRead.enforceImageBudget(messages, { convert: null });
  assert.deepEqual(out, messages);
});
