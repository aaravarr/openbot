import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
  TOTAL_IMAGE_OMIT_PLACEHOLDER: string;
};

const PNG = (require("pngjs") as { PNG: new (opts: { width: number; height: number }) => { data: Buffer; width: number; height: number } }).PNG;
const pngSyncWrite = (require("pngjs") as { PNG: { sync: { write: (png: unknown) => Buffer } } }).PNG.sync.write;
const jpegjs = require("jpeg-js") as {
  decode: (buf: Buffer) => { width: number; height: number };
  encode: (image: { data: Buffer; width: number; height: number }, quality: number) => { data: Buffer };
};

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
  assert.equal(out, messages);
});

test("an over-budget image is degraded before it is omitted, and the invariant holds", async () => {
  const normalized = await imageRead.prepareImageForModel(largePng, "image/png", { convert: null });
  assert.equal(normalized.mime, "image/jpeg");
  const dataUrl = imageRead.dataUrlFromBuffer(normalized.buffer, normalized.mime);
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];
  // One byte under the normalized size: the ladder must step in, and the
  // smallest rung (q50, 768px) is far below it, so the image survives.
  const budget = normalized.buffer.length - 1;
  const out = (await imageRead.enforceImageBudget(messages, { budget, convert: null })) as {
    content: { type: string; text?: string; image_url?: { url: string } }[];
  }[];
  const serialized = Buffer.byteLength(JSON.stringify(out), "utf8");
  assert.ok(serialized <= budget, `serialized ${serialized} > budget ${budget}`);
  assert.equal((out[0]?.content[1] as { type: string }).type, "image_url");
  const finalUrl = (out[0]?.content[1] as { image_url?: { url: string } }).image_url?.url ?? "";
  const finalBytes = Buffer.from(finalUrl.slice(finalUrl.indexOf(",") + 1), "base64");
  assert.ok(finalBytes.length < normalized.buffer.length, "degraded image must be smaller");
  const decoded = jpegjs.decode(finalBytes);
  assert.ok(Math.max(decoded.width, decoded.height) <= imageRead.DEFAULT_MAX_EDGE);
});

test("an image that cannot fit the budget is replaced with the omit placeholder", async () => {
  // Byte-distinct, sub-image-budget fixtures: the point is the final omit
  // pass, so the total image budget must not bind here (byte-level dedup also
  // collapses identical copies before the budget pass ever runs).
  const make = (flipByte: number) => {
    const bytes = noisePng(400, 300);
    bytes[flipByte] = (bytes[flipByte] ?? 0) ^ 0xff;
    return {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: imageRead.dataUrlFromBuffer(bytes, "image/png") } },
      ],
    };
  };
  const out = (await imageRead.enforceImageBudget([make(100), make(200)], {
    budget: 50 * 1024,
    convert: null,
  })) as { content: { type: string; text?: string }[] }[];
  const serialized = Buffer.byteLength(JSON.stringify(out), "utf8");
  assert.ok(serialized <= 50 * 1024, `serialized ${serialized} > budget`);
  for (const msg of out) {
    const imageParts = (msg.content as { type: string }[]).filter((p) => p.type === "image_url");
    assert.equal(imageParts.length, 0);
    const notes = (msg.content as { type: string; text?: string }[]).filter(
      (p) => p.type === "text" && p.text === "[image omitted: budget]",
    );
    assert.equal(notes.length, 1);
  }
});

test("http(s) image urls are never compressed or omitted", async () => {
  const dataUrl = imageRead.dataUrlFromBuffer(largePng, "image/png");
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "remote" },
        { type: "image_url", image_url: { url: "https://example.com/pixel.png" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "text", text: "inline" },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];
  const out = (await imageRead.enforceImageBudget(messages, {
    budget: 50 * 1024,
    convert: null,
  })) as { content: { type: string; text?: string; image_url?: { url: string } }[] }[];
  const first = out[0]?.content[1] as { image_url?: { url: string } };
  assert.equal(first.image_url?.url, "https://example.com/pixel.png");
  const secondParts = out[1]?.content as { type: string; text?: string }[];
  assert.equal(
    secondParts.some((p) => p.type === "text" && p.text === "[image omitted: budget]"),
    true,
  );
});

test("a small image under the default budget passes through byte-identical", async () => {
  const small = noisePng(32, 32);
  const dataUrl = imageRead.dataUrlFromBuffer(small, "image/png");
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "tiny" },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    },
  ];
  const out = await imageRead.enforceImageBudget(messages, { convert: null });
  assert.equal(out, messages);
  const parts = (out[0] as { content: { image_url?: { url: string } }[] }).content;
  assert.equal(parts[1]?.image_url?.url, dataUrl);
});

// Synthetic bytes no decoder accepts: normalization and the degrade ladder
// no-op, so the budget pass exercises omission deterministically. Lengths are
// aligned with the observed incident scale without embedding real payloads.
function fakeImageDataUrl(sizeBytes: number): string {
  return imageRead.dataUrlFromBuffer(randomBytes(sizeBytes), "image/png");
}

type ImageContent = { type: string; text?: string; image_url?: { url: string } };

function imageMessage(text: string, dataUrl: string) {
  return {
    role: "user",
    content: [
      { type: "text", text },
      { type: "image_url", image_url: { url: dataUrl } },
    ] as ImageContent[],
  };
}

function hasOmitNote(parts: ImageContent[] | undefined): boolean {
  return (parts ?? []).some((p) => p.type === "text" && p.text === "[image omitted: budget]");
}

function hasAnyOmitNote(parts: ImageContent[] | undefined): boolean {
  return hasOmitNote(parts) ||
    (parts ?? []).some((p) => p.type === "text" && p.text === imageRead.TOTAL_IMAGE_OMIT_PLACEHOLDER);
}

function hasImage(parts: ImageContent[] | undefined): boolean {
  return (parts ?? []).some((p) => p.type === "image_url");
}

test("budget pressure omits the oldest images first and keeps the newest intact", async () => {
  // Byte-distinct same-size images (see the omit test above: dedup collapses
  // identical copies first, so budget-order fixtures must be distinct).
  const make = (flipByte: number) => {
    const bytes = randomBytes(100 * 1024);
    bytes[flipByte] = (bytes[flipByte] ?? 0) ^ 0xff;
    return imageMessage("look", imageRead.dataUrlFromBuffer(bytes, "image/png"));
  };
  const messages = [make(0), make(1), make(2)];
  const s0 = Buffer.byteLength(JSON.stringify(messages), "utf8");
  const dataUrl = ((messages[0] as { content: { image_url?: { url: string } }[] }).content[1]
    ?.image_url?.url) ?? "";
  const newestUrl = ((messages[2] as { content: { image_url?: { url: string } }[] }).content[1]
    ?.image_url?.url) ?? "";
  // Fits after exactly two omissions: the oldest two are dropped, the
  // newest image survives.
  const budget = s0 - 2 * dataUrl.length + 400;
  const out = (await imageRead.enforceImageBudget(messages, { budget, convert: null })) as {
    content: ImageContent[];
  }[];
  const serialized = Buffer.byteLength(JSON.stringify(out), "utf8");
  assert.ok(serialized <= budget, `serialized ${serialized} > budget ${budget}`);
  assert.equal(hasOmitNote(out[0]?.content), true, "oldest image must be omitted first");
  assert.equal(hasOmitNote(out[1]?.content), true, "second-oldest image must be omitted second");
  assert.equal(hasOmitNote(out[2]?.content), false, "newest image must not be omitted");
  assert.equal(hasImage(out[2]?.content), true, "newest image must be kept");
  assert.equal((out[2]?.content[1] as { image_url?: { url: string } }).image_url?.url, newestUrl);
});

// Smooth gradients re-encode far smaller at q70 than q85, so a degrade step
// always shrinks them (pure noise would not — generation loss inflates it).
function gradientJpeg(width: number, height: number, quality: number): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const v = Math.floor(((x + y) * 255) / (width + height));
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return Buffer.from(jpegjs.encode({ data, width, height }, quality).data);
}

test("budget degrade steps the oldest image down first and keeps the newest untouched", async () => {
  const older = gradientJpeg(800, 600, 85);
  const newer = gradientJpeg(1600, 1200, 85);
  assert.ok(newer.length > older.length, "fixture needs the newer image larger");
  const olderUrl = imageRead.dataUrlFromBuffer(older, "image/jpeg");
  const newerUrl = imageRead.dataUrlFromBuffer(newer, "image/jpeg");
  const messages = [imageMessage("old", olderUrl), imageMessage("new", newerUrl)];
  const s0 = Buffer.byteLength(JSON.stringify(messages), "utf8");
  const out = (await imageRead.enforceImageBudget(messages, { budget: s0 - 1, convert: null })) as {
    content: ImageContent[];
  }[];
  const serialized = Buffer.byteLength(JSON.stringify(out), "utf8");
  assert.ok(serialized <= s0 - 1, `serialized ${serialized} > budget ${s0 - 1}`);
  assert.equal(hasOmitNote(out[0]?.content), false, "degrade must fit without omission");
  assert.equal(hasOmitNote(out[1]?.content), false, "degrade must fit without omission");
  const firstUrl = (out[0]?.content[1] as { image_url?: { url: string } }).image_url?.url ?? "";
  const secondUrl = (out[1]?.content[1] as { image_url?: { url: string } }).image_url?.url ?? "";
  assert.ok(firstUrl.length < olderUrl.length, "oldest image must be degraded first");
  assert.ok(
    secondUrl.length === newerUrl.length && secondUrl.endsWith(newerUrl.slice(-64)),
    "newest image must keep its quality",
  );
});

test("the default budget clamps an incident-scale payload by omitting oldest images first", async () => {
  // Locks the post-incident budget: the fusion gateway edge allows 10 MiB but
  // its upstream rejected a real ~9.2 MB payload with 413 (request
  // a16ed054-4bac-49fd-89b9-cd75c38c797a), so the default must stay below it.
  // The total image budget clamps first (oldest history omitted until the
  // summed data-URL bytes fit), so the payload lands far under 8 MiB even
  // though these synthetic bytes cannot be re-encoded.
  assert.equal(imageRead.MAX_REQUEST_MESSAGE_BYTES, 8 * 1024 * 1024);
  const messages = Array.from({ length: 8 }, (_, i) =>
    imageMessage(`turn ${i}`, fakeImageDataUrl(1250 * 1024)),
  );
  const out = (await imageRead.enforceImageBudget(messages, { convert: null })) as {
    content: ImageContent[];
  }[];
  const serialized = Buffer.byteLength(JSON.stringify(out), "utf8");
  assert.ok(serialized <= imageRead.MAX_REQUEST_MESSAGE_BYTES, `serialized ${serialized} > default budget`);
  assert.ok(serialized <= 4.5 * 1024 * 1024, `serialized ${serialized} > 4.5 MiB success zone`);
  for (let i = 0; i < 7; i++) {
    assert.equal(
      hasAnyOmitNote(out[i]?.content),
      true,
      `message ${i} (oldest history) must be omitted by the image budget`,
    );
  }
  assert.equal(hasImage(out[7]?.content), true, "newest (current-turn) image must be kept");
  assert.equal(
    (out[7]?.content[1] as { image_url?: { url: string } }).image_url?.url,
    ((messages[7] as { content: { image_url?: { url: string } }[] }).content[1]?.image_url?.url) ?? "",
    "current-turn image must survive byte-identical",
  );
});
