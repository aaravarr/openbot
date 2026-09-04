import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const imageRead = require(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/image-read.cjs")) as {
  enforceImageBudget: (
    messages: unknown,
    options?: { budget?: number; convert?: unknown },
  ) => Promise<unknown[]>;
  dataUrlFromBuffer: (buffer: Buffer, mime: string) => string;
  currentTurnStartIndex: (messages: unknown[]) => number;
  HISTORY_IMAGE_TARGET_BYTES: number;
  TOTAL_IMAGE_BUDGET_BYTES: number;
  BUDGET_OMIT_PLACEHOLDER: string;
  DEDUP_OMIT_PLACEHOLDER: string;
  TOTAL_IMAGE_OMIT_PLACEHOLDER: string;
};

const jpegjs = require("jpeg-js") as {
  encode: (image: { data: Buffer; width: number; height: number }, quality: number) => { data: Buffer };
};

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

// Same shape the hop injects after a Read-style tool result (enrichImageReads
// runs before governance on the hop path).
function injectedImageMessage(label: string, dataUrl: string) {
  return imageMessage(label, dataUrl);
}

function partsOf(msg: unknown): ImageContent[] {
  return ((msg as { content?: ImageContent[] }).content ?? []) as ImageContent[];
}

function imageUrlOf(msg: unknown): string | undefined {
  return partsOf(msg).find((p) => p.type === "image_url")?.image_url?.url;
}

function textPartsOf(msg: unknown): string[] {
  return partsOf(msg).filter((p) => p.type === "text").map((p) => p.text ?? "");
}

function decodedBytesOf(url: string): number {
  const payload = url.slice(url.indexOf(",") + 1);
  return Buffer.from(payload, "base64").length;
}

// Deterministic JPEG well above the history target (a smooth gradient at q98
// encodes to ~170 KB), so the history quota has something to squeeze.
function bigGradient(width: number, height: number, quality: number, phase = 1): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      const v = Math.floor(((x + phase * y) * 255) / (width + phase * height));
      data[o] = v;
      data[o + 1] = v;
      data[o + 2] = v;
      data[o + 3] = 255;
    }
  }
  return Buffer.from(jpegjs.encode({ data, width, height }, quality).data);
}

test("byte-identical images collapse to the latest occurrence with plain-text placeholders", async () => {
  const a = imageRead.dataUrlFromBuffer(randomBytes(2048), "image/png");
  const b = imageRead.dataUrlFromBuffer(randomBytes(2048), "image/png");
  const messages = [imageMessage("m0", a), imageMessage("m1", a), imageMessage("m2", a), imageMessage("m3", b)];
  const out = (await imageRead.enforceImageBudget(messages, { convert: null })) as unknown[];

  assert.equal(textPartsOf(out[0])[1], imageRead.DEDUP_OMIT_PLACEHOLDER, "oldest copy gets the placeholder");
  assert.equal(textPartsOf(out[1])[1], imageRead.DEDUP_OMIT_PLACEHOLDER, "second-oldest copy gets the placeholder");
  assert.equal(textPartsOf(out[2]).includes(imageRead.DEDUP_OMIT_PLACEHOLDER), false, "latest copy is kept");
  assert.equal(imageUrlOf(out[2]), a, "latest identical copy keeps its bytes");
  assert.equal(imageUrlOf(out[3]), b, "a different image is never deduped");
  // No budget pressure at these sizes: the 8 MiB omit note must not appear.
  assert.equal(textPartsOf(out[0]).includes(imageRead.BUDGET_OMIT_PLACEHOLDER), false);
});

test("dedup keeps the copy closest to the current turn", async () => {
  const a = imageRead.dataUrlFromBuffer(randomBytes(2048), "image/png");
  const b = imageRead.dataUrlFromBuffer(randomBytes(2048), "image/png");
  const messages = [imageMessage("t0", a), imageMessage("t1", b), imageMessage("t2", a)];
  const out = (await imageRead.enforceImageBudget(messages, { convert: null })) as unknown[];

  assert.equal(textPartsOf(out[0])[1], imageRead.DEDUP_OMIT_PLACEHOLDER, "history copy is dropped");
  assert.equal(imageUrlOf(out[1]), b);
  assert.equal(imageUrlOf(out[2]), a, "the current-turn copy survives");
});

test("several same-turn injections all count as current turn and keep their bytes", async () => {
  const a = imageRead.dataUrlFromBuffer(bigGradient(1600, 1200, 98), "image/jpeg");
  const b = imageRead.dataUrlFromBuffer(bigGradient(1600, 1200, 98, 2), "image/jpeg");
  assert.ok(decodedBytesOf(a) > imageRead.HISTORY_IMAGE_TARGET_BYTES, "fixture must exceed the history target");
  const messages = [
    { role: "user", content: "please look" },
    injectedImageMessage("[Image attached from Read: C:\\shots\\a.png]", a),
    injectedImageMessage("[Image attached from tool result]", b),
  ];
  const out = (await imageRead.enforceImageBudget(messages, { convert: null })) as unknown[];

  assert.equal(imageUrlOf(out[1]), a, "same-turn injection 1 stays byte-identical");
  assert.equal(imageUrlOf(out[2]), b, "same-turn injection 2 stays byte-identical");
});

test("history images are squeezed under the per-image target; current-turn images are not", async () => {
  const histBytes = bigGradient(1600, 1200, 98);
  const curBytes = bigGradient(1600, 1200, 98, 2);
  const histUrl = imageRead.dataUrlFromBuffer(histBytes, "image/jpeg");
  const curUrl = imageRead.dataUrlFromBuffer(curBytes, "image/jpeg");
  assert.ok(histBytes.length > imageRead.HISTORY_IMAGE_TARGET_BYTES);
  assert.ok(curBytes.length > imageRead.HISTORY_IMAGE_TARGET_BYTES);

  const run = async () => {
    const messages = [imageMessage("turn 0", histUrl), imageMessage("turn 1", curUrl)];
    const out = (await imageRead.enforceImageBudget(messages, { convert: null })) as unknown[];
    return out;
  };
  const first = await run();
  assert.ok(decodedBytesOf(imageUrlOf(first[0]) ?? "") <= imageRead.HISTORY_IMAGE_TARGET_BYTES,
    "history image must be squeezed under the target");
  assert.ok((imageUrlOf(first[0]) ?? "").startsWith("data:image/jpeg;base64,"));
  assert.equal(imageUrlOf(first[1]), curUrl, "current-turn image must stay byte-identical");

  // The same history bytes arrive again next round: the re-encode cache must
  // reproduce the same compressed output, not re-encode or drift.
  const second = await run();
  assert.equal(imageUrlOf(second[0]), imageUrlOf(first[0]), "cached re-encode is stable across rounds");
  assert.equal(imageUrlOf(second[1]), curUrl);
});

test("currentTurnStartIndex skips the hop's own injected image messages", () => {
  const inject = (url: string) => injectedImageMessage("[Image attached from Read: x.png]", url);
  const url = imageRead.dataUrlFromBuffer(randomBytes(32), "image/png");
  assert.equal(
    imageRead.currentTurnStartIndex([
      { role: "user", content: "first" },
      inject(url),
      { role: "user", content: "second" },
      inject(url),
    ]),
    2,
    "the last non-injected user message starts the current turn",
  );
  assert.equal(
    imageRead.currentTurnStartIndex([inject(url), inject(url)]),
    2,
    "without a real user message every image counts as history",
  );
});

// Incident 2026-09-04 (request a16ed054), replayed with synthetic bytes at the
// same structural scale — no real base64, no conversation content: 45
// history-image copies of 26 distinct images (one screenshot re-read 17
// times, one 4 times, one twice), plus one small current-turn image. All
// synthetic bytes are undecodable, so compression no-ops and the dedup +
// total-budget layers do all the work.
test("an incident-shaped image history collapses into the upstream success zone", async () => {
  const distinct: Buffer[] = [];
  for (let i = 0; i < 22; i++) {
    distinct.push(randomBytes(131072 + ((i * 4096) % 49152)));
  }
  const a = randomBytes(137262); // the screenshot re-read 17 times
  const b = randomBytes(168795); // re-read 4 times
  const c = randomBytes(162012); // re-read twice
  const current = randomBytes(28672);

  const urlOf = (buf: Buffer) => imageRead.dataUrlFromBuffer(buf, "image/jpeg");
  const messages: unknown[] = [];
  for (const single of distinct) messages.push(imageMessage(`turn ${messages.length}`, urlOf(single)));
  for (let i = 0; i < 17; i++) messages.push(imageMessage(`reread a ${i}`, urlOf(a)));
  for (let i = 0; i < 4; i++) messages.push(imageMessage(`reread b ${i}`, urlOf(b)));
  messages.push(imageMessage("reread c 0", urlOf(c)));
  messages.push(imageMessage("reread c 1", urlOf(c)));
  messages.push(imageMessage("current turn", urlOf(current)));
  assert.equal(messages.length, 46);

  const out = (await imageRead.enforceImageBudget(messages, { convert: null })) as unknown[];

  // Dedup: 16 + 3 + 1 earlier identical copies become placeholders, and the
  // latest occurrence of each distinct image survives.
  const dedupNotes = out.filter((m) => textPartsOf(m)[1] === imageRead.DEDUP_OMIT_PLACEHOLDER);
  assert.equal(dedupNotes.length, 20, "every earlier identical copy becomes a placeholder");
  assert.equal(imageUrlOf(out[38]), urlOf(a), "latest copy of the 17x image is kept");
  assert.equal(imageUrlOf(out[42]), urlOf(b), "latest copy of the 4x image is kept");
  assert.equal(imageUrlOf(out[44]), urlOf(c), "latest copy of the 2x image is kept");
  assert.equal(imageUrlOf(out[45]), urlOf(current), "current-turn image is kept");

  // Total image budget: oldest distinct images (the singles) are squeezed out
  // first, so every total-budget placeholder sits before the dup groups.
  const totalOmitted = out.filter((m) => textPartsOf(m)[1] === imageRead.TOTAL_IMAGE_OMIT_PLACEHOLDER);
  assert.ok(totalOmitted.length >= 1, "the image budget must trim the oldest history");
  const firstDupGroup = out.findIndex((m) => imageUrlOf(m) === urlOf(a));
  for (const m of totalOmitted) {
    assert.ok(out.indexOf(m) < firstDupGroup, "total-budget omissions hit the oldest history first");
  }

  let imagePayload = 0;
  for (const m of out) {
    const url = imageUrlOf(m);
    if (url) imagePayload += url.length;
  }
  assert.ok(imagePayload <= imageRead.TOTAL_IMAGE_BUDGET_BYTES, `image payload ${imagePayload} exceeds the budget`);

  const serialized = Buffer.byteLength(JSON.stringify(out), "utf8");
  assert.ok(serialized <= 4.5 * 1024 * 1024, `serialized ${serialized} must land in the ~4.5 MB success zone`);
  assert.ok(serialized >= 650 * 1024, `serialized ${serialized} must not over-omit the deduped history`);
  // The 8 MiB request budget is never reached in this scenario.
  for (const m of out) {
    assert.equal(textPartsOf(m).includes(imageRead.BUDGET_OMIT_PLACEHOLDER), false);
  }
});
