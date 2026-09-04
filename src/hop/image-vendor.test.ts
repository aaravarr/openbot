import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const payloadDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload");
const repoRoot = path.join(payloadDir, "..");
const imageRead = require(path.join(payloadDir, "image-read.cjs")) as {
  imageLibsSource: () => string;
  prepareImageForModel: (
    buffer: Buffer,
    mime: string,
    options?: { quality?: number; maxEdge?: number; convert?: unknown },
  ) => Promise<{ buffer: Buffer; mime: string }>;
};

type PngJsModule = {
  PNG: new (opts: { width: number; height: number }) => { data: Buffer; width: number; height: number };
} & {
  PNG: { sync: { read: (buffer: Buffer) => { data: Buffer; width: number; height: number }; write: (png: unknown) => Buffer } };
};

type JpegJsModule = {
  encode: (image: { data: Buffer; width: number; height: number }, quality: number) => { data: Buffer };
  decode: (buffer: Buffer) => { width: number; height: number; data: Buffer };
};

const vendorPngjs = require(path.join(payloadDir, "vendor", "pngjs")) as PngJsModule;
const vendorJpegJs = require(path.join(payloadDir, "vendor", "jpeg-js")) as JpegJsModule;

function readJson(file: string): { version: string } {
  return JSON.parse(readFileSync(file, "utf8")) as { version: string };
}

function rootDependencies(): Record<string, string> {
  return (JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  }).dependencies;
}

test("vendored compression libraries exist, match the declared dependency versions, and keep their licenses", () => {
  for (const pkg of ["pngjs", "jpeg-js"]) {
    assert.equal(existsSync(path.join(payloadDir, "vendor", pkg, "package.json")), true, `${pkg} package.json`);
    assert.equal(existsSync(path.join(payloadDir, "vendor", pkg, "LICENSE")), true, `${pkg} LICENSE`);
  }
  const deps = rootDependencies();
  assert.equal(readJson(path.join(payloadDir, "vendor", "pngjs", "package.json")).version, String(deps["pngjs"]).replace(/^[\^~]/, ""));
  assert.equal(readJson(path.join(payloadDir, "vendor", "jpeg-js", "package.json")).version, String(deps["jpeg-js"]).replace(/^[\^~]/, ""));
});

test("vendored copies decode and encode images standalone", () => {
  // Encode a gradient to PNG with the vendored pngjs, decode it back, then
  // re-encode as JPEG with the vendored jpeg-js and decode again: the full
  // ladder works from the vendored files alone.
  const png = new vendorPngjs.PNG({ width: 64, height: 48 });
  for (let i = 0; i < 64 * 48; i += 1) {
    const o = i * 4;
    png.data[o] = i & 255;
    png.data[o + 1] = (i * 3) & 255;
    png.data[o + 2] = (i * 7) & 255;
    png.data[o + 3] = 255;
  }
  const pngBytes = vendorPngjs.PNG.sync.write(png);
  const decoded = vendorPngjs.PNG.sync.read(pngBytes);
  assert.equal(decoded.width, 64);
  const jpeg = vendorJpegJs.encode({ data: Buffer.from(decoded.data), width: 64, height: 48 }, 85);
  const roundTrip = vendorJpegJs.decode(jpeg.data);
  assert.equal(roundTrip.width, 64);
  assert.ok(jpeg.data.length > 0);
});

test("the hop lazy loader resolves the vendored copies first", () => {
  assert.equal(imageRead.imageLibsSource(), "vendor");
});

test("compression works from the vendored copies alone, with no node_modules next to the loader", async () => {
  // Recreate the tarball-install shape: image-read.cjs + payload/vendor,
  // nothing else. The loader must serve compression from the vendor tree.
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-vendor-only-"));
  const inner = path.join(dir, "payload");
  mkdirSync(inner);
  cpSync(path.join(payloadDir, "image-read.cjs"), path.join(inner, "image-read.cjs"));
  cpSync(path.join(payloadDir, "vendor"), path.join(inner, "vendor"), { recursive: true });

  const isolated = require(path.join(inner, "image-read.cjs")) as typeof imageRead;
  assert.equal(isolated.imageLibsSource(), "vendor");

  // 900x700 noise PNG: over the 600 KB pass-through line, so the re-encode
  // ladder has to run end-to-end on the vendored libraries.
  const png = new vendorPngjs.PNG({ width: 900, height: 700 });
  let seed = 987654321;
  const rng = (): number => {
    seed ^= seed << 13;
    seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    seed >>>= 0;
    return seed;
  };
  for (let i = 0; i < 900 * 700; i += 1) {
    const o = i * 4;
    png.data[o] = rng() & 255;
    png.data[o + 1] = rng() & 255;
    png.data[o + 2] = rng() & 255;
    png.data[o + 3] = 255;
  }
  const bigNoise = vendorPngjs.PNG.sync.write(png);
  assert.ok(bigNoise.length > 600 * 1024, "fixture must exceed the pass-through size");
  const result = await isolated.prepareImageForModel(bigNoise, "image/png", { convert: null });
  assert.equal(result.mime, "image/jpeg");
  assert.ok(result.buffer.length < bigNoise.length, "re-encode must shrink a noise PNG");
});
