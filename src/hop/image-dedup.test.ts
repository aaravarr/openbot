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
    options?: {
      budget?: number;
      convert?: unknown;
      historyTarget?: number;
      currentTurnBudget?: number;
      extraWireBytes?: number;
    },
  ) => Promise<unknown[]>;
  dataUrlFromBuffer: (buffer: Buffer, mime: string) => string;
  currentTurnStartIndex: (messages: unknown[]) => number;
  currentTurnImagePayloadBytes: (images: unknown[]) => number;
  MAX_REQUEST_WIRE_BYTES: number;
  WIRE_HEADROOM_BYTES: number;
  HISTORY_IMAGE_TARGET_BYTES: number;
  CURRENT_TURN_IMAGE_BUDGET_BYTES: number;
  BUDGET_OMIT_PLACEHOLDER: string;
  DEDUP_OMIT_PLACEHOLDER: string;
  CURRENT_TURN_IMAGE_OMIT_PLACEHOLDER: string;
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
  const content = (msg as { content?: unknown }).content;
  return Array.isArray(content) ? (content as ImageContent[]) : [];
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
// encodes to ~172 KB in ~60 ms), so the history quota has something to squeeze
// and incident-scale fixtures stay fast.
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
  // No budget pressure at these sizes: the wire-budget omit note must not appear.
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

test("several copies inside one message dedup too; distinct parts are untouched", async () => {
  const a = imageRead.dataUrlFromBuffer(randomBytes(2048), "image/png");
  const b = imageRead.dataUrlFromBuffer(randomBytes(2048), "image/png");
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: "two copies of one screenshot plus a different one" },
        { type: "image_url", image_url: { url: a } },
        { type: "image_url", image_url: { url: a } },
        { type: "image_url", image_url: { url: b } },
      ] as ImageContent[],
    },
  ];
  const out = (await imageRead.enforceImageBudget(messages, { convert: null })) as unknown[];
  const parts = partsOf(out[0]);
  assert.equal(parts[1]?.type, "text", "the earlier identical part becomes the placeholder");
  assert.equal(parts[1]?.text, imageRead.DEDUP_OMIT_PLACEHOLDER);
  assert.equal(parts[2]?.image_url?.url, a, "the later identical part is kept");
  assert.equal(parts[3]?.image_url?.url, b, "the distinct part is kept");
});

test("a user-attached image in the current turn wins over an identical history copy", async () => {
  const attached = imageRead.dataUrlFromBuffer(bigGradient(1600, 1200, 98), "image/jpeg");
  const messages = [
    injectedImageMessage("[Image attached from Read: C:\\shots\\old.png]", attached),
    { role: "user", content: "and now compare with this" },
    {
      role: "user",
      content: [
        { type: "text", text: "same file attached again" },
        { type: "image_url", image_url: { url: attached } },
      ] as ImageContent[],
    },
  ];
  const out = (await imageRead.enforceImageBudget(messages, { convert: null })) as unknown[];

  assert.equal(textPartsOf(out[0])[1], imageRead.DEDUP_OMIT_PLACEHOLDER, "the history copy yields");
  assert.equal(imageUrlOf(out[2]), attached, "the current-turn attachment keeps its bytes");
  assert.equal(partsOf(out[2]).filter((p) => p.type === "image_url").length, 1);
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

// --- Current-turn image cap --------------------------------------------------

// The realistic current-turn shape: the last real user message, then the Read
// injections the hop places after it — all of them belong to the turn.
function currentTurnMessages(historyUrl: string, turnUrls: string[]): unknown[] {
  return [
    imageMessage("tiny history", historyUrl),
    { role: "user", content: "look at these" },
    ...turnUrls.map((url, i) => injectedImageMessage(`[Image attached from Read: shot-${i}.png]`, url)),
  ];
}

test("a multi-image current turn over the cap squeezes oldest first and keeps the newest intact", async () => {
  const cap = 400 * 1024;
  const url = (phase: number) => imageRead.dataUrlFromBuffer(bigGradient(1600, 1200, 98, phase), "image/jpeg");
  const firstUrl = url(11);
  const secondUrl = url(12);
  const newestUrl = url(13);
  assert.ok(decodedBytesOf(firstUrl) > 96 * 1024, "fixture must start above the history target");
  const messages = currentTurnMessages(
    imageRead.dataUrlFromBuffer(bigGradient(400, 300, 85), "image/jpeg"),
    [firstUrl, secondUrl, newestUrl],
  );
  const out = (await imageRead.enforceImageBudget(messages, { convert: null, currentTurnBudget: cap })) as unknown[];

  // The cap binds (three ~230 KB data URLs > 400 KB), so the oldest two step
  // down the ladder until it fits, and the newest keeps its exact bytes.
  assert.ok(decodedBytesOf(imageUrlOf(out[2]) ?? "") < decodedBytesOf(firstUrl), "oldest current-turn image degrades first");
  assert.ok(decodedBytesOf(imageUrlOf(out[3]) ?? "") < decodedBytesOf(secondUrl), "second-oldest degrades next");
  assert.equal(imageUrlOf(out[4]), newestUrl, "the newest current-turn image must stay byte-identical");
  assert.equal(imageUrlOf(out[0]), (messages[0] as { content: ImageContent[] }).content[1]?.image_url?.url,
    "the cap pass must not touch history images");
  for (const m of out) {
    assert.equal(partsOf(m).some((p) => p.type === "text" && p.text === imageRead.CURRENT_TURN_IMAGE_OMIT_PLACEHOLDER),
      false, "this cap leaves room for all three images; nothing may be omitted");
  }
});

test("an over-cap current turn omits oldest first and never drops its last image", async () => {
  const tinyCap = 5 * 1024;
  const url = (phase: number) => imageRead.dataUrlFromBuffer(bigGradient(1600, 1200, 98, phase), "image/jpeg");
  const messages = currentTurnMessages(
    imageRead.dataUrlFromBuffer(bigGradient(400, 300, 85), "image/jpeg"),
    [url(21), url(22), url(23)],
  );
  const out = (await imageRead.enforceImageBudget(messages, { convert: null, currentTurnBudget: tinyCap })) as unknown[];

  // The ladder bottoms out far above this cap, so current-turn images are
  // omitted oldest-first until only the newest remains - the last live
  // current-turn image is never dropped.
  assert.equal(
    partsOf(out[2]).some((p) => p.type === "text" && p.text === imageRead.CURRENT_TURN_IMAGE_OMIT_PLACEHOLDER),
    true,
    "the oldest current-turn image is omitted first",
  );
  assert.equal(
    partsOf(out[3]).some((p) => p.type === "text" && p.text === imageRead.CURRENT_TURN_IMAGE_OMIT_PLACEHOLDER),
    true,
    "the second-oldest is omitted next",
  );
  assert.equal(partsOf(out[4]).some((p) => p.type === "image_url"), true, "the newest image must remain");
  const liveUrls = [out[2], out[3], out[4]]
    .flatMap((m) => partsOf(m).filter((p) => p.type === "image_url").map((p) => p.image_url?.url ?? ""));
  assert.equal(liveUrls.length, 1, "exactly the newest image survives the omit phase");
  assert.ok(liveUrls[0] && liveUrls[0].length > tinyCap, "the survivor is the ladder-bottomed newest image");
});

test("a single-image current turn is squeezed but never omitted, whatever the cap says", async () => {
  const url = imageRead.dataUrlFromBuffer(bigGradient(1600, 1200, 98, 31), "image/jpeg");
  const messages = [imageMessage("the only screenshot", url)];
  const out = (await imageRead.enforceImageBudget(messages, { convert: null, currentTurnBudget: 20 * 1024 })) as unknown[];

  assert.equal(partsOf(out[0]).some((p) => p.type === "image_url"), true, "the image must survive");
  assert.ok((imageUrlOf(out[0]) ?? "").length < url.length, "it may be squeezed, though");
  assert.equal(
    partsOf(out[0]).some((p) => p.type === "text" && p.text === imageRead.CURRENT_TURN_IMAGE_OMIT_PLACEHOLDER),
    false,
    "the only current-turn image must never be replaced by a placeholder",
  );
  assert.equal(
    partsOf(out[0]).some((p) => p.type === "text" && p.text === imageRead.BUDGET_OMIT_PLACEHOLDER),
    false,
    "the wire net must not fire for a payload this small",
  );
});

// --- Wire-wide budget accounting ---------------------------------------------

const hopHandler = require(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/hop-handler.cjs")) as {
  outboundEnvelopeBytes: (body: Record<string, unknown>) => number;
};

test("outboundEnvelopeBytes measures tools and envelope, not messages", () => {
  const tools = [{ type: "function", function: { name: "Read", description: "x".repeat(1024) } }];
  const messages = [{ role: "user", content: "hi" }];
  const body = { model: "test-model", stream: false, tools, messages };
  const envelope = hopHandler.outboundEnvelopeBytes(body);
  const expected = Buffer.byteLength(
    JSON.stringify({ model: "test-model", stream: false, tools, messages: [] }),
    "utf8",
  );
  assert.equal(envelope, expected);
  assert.ok(envelope > 1024, "the tools must be counted");
  // messages + envelope ≈ the real wire (a couple of structural bytes apart).
  const wire = envelope + Buffer.byteLength(JSON.stringify(messages), "utf8");
  const actual = Buffer.byteLength(JSON.stringify(body), "utf8");
  assert.ok(Math.abs(wire - actual) < 8, `envelope+messages (${wire}) must reconstruct the wire (${actual})`);
});

test("extraWireBytes makes the wire net omit even when messages alone fit", async () => {
  const messages = Array.from({ length: 8 }, (_, i) =>
    imageMessage(`turn ${i}`, imageRead.dataUrlFromBuffer(randomBytes(256 * 1024), "image/png")),
  );
  const messagesBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
  assert.ok(messagesBytes < imageRead.MAX_REQUEST_WIRE_BYTES, "precondition: messages alone fit the wire");
  const extraWireBytes = 2.5 * 1024 * 1024; // tools + envelope as the hop measures them
  const out = (await imageRead.enforceImageBudget(messages, { convert: null, extraWireBytes })) as unknown[];
  const serialized = Buffer.byteLength(JSON.stringify(out), "utf8");
  assert.ok(
    serialized <= imageRead.MAX_REQUEST_WIRE_BYTES - extraWireBytes,
    `serialized ${serialized} must fit inside the wire budget minus the envelope`,
  );
  // Oldest history images are omitted first; the newest (current turn) survives.
  assert.equal(partsOf(out[0]).some((p) => p.type === "image_url"), false, "oldest image must be omitted");
  assert.equal(partsOf(out[7]).some((p) => p.type === "image_url"), true, "current-turn image must survive");
  const liveCount = out.filter((m) => partsOf(m).some((p) => p.type === "image_url")).length;
  assert.ok(liveCount < 8, "the wire net must have omitted something");
});

test("the default wire budget is 4 MiB and governance reserves envelope headroom", () => {
  // Three on-the-box samples pinned the upstream limit to [4.43, 4.6) MB of
  // wire (success at 4.43 MB; 4.6-4.8 MB bodies still 413'd), so the net sits
  // at 4 MiB full-wire with >0.2 MB of margin under the proven success.
  assert.equal(imageRead.MAX_REQUEST_WIRE_BYTES, 4 * 1024 * 1024);
  assert.ok(imageRead.WIRE_HEADROOM_BYTES >= 1024, "headroom must cover max_tokens and parameter maps");
  assert.ok(imageRead.WIRE_HEADROOM_BYTES <= 64 * 1024, "headroom must not eat the image budget");
});

// Incident 2026-09-04 (request a16ed054-4bac-49fd-89b9-cd75c38c797a), replayed
// with synthetic bytes at the same structural scale — no real base64, no
// conversation content, no real tool schemas: 45 history-image copies of 26
// distinct images (one screenshot re-read 17 times, one 4 times, one twice),
// ~0.6 MB of filler text, ~0.23 MB of synthetic tools, and one small
// current-turn image. The dedup + history-quota + current-turn-cap layers must
// land the full outbound wire inside the proven upstream success zone.
test("an incident-shaped wire (45 images, tools, text) lands in the success zone", async () => {
  // 26 distinct history images (23 singles + the 17x/4x/2x groups), each a
  // decodable JPEG well above the history target so the quota has real work.
  const distinct: Buffer[] = [];
  for (let i = 0; i < 26; i++) distinct.push(bigGradient(1600, 1200, 98, i + 1));
  const current = randomBytes(28672);

  const urlOf = (buf: Buffer) => imageRead.dataUrlFromBuffer(buf, "image/jpeg");
  const a = distinct[23] as Buffer; // the screenshot re-read 17 times
  const b = distinct[24] as Buffer; // re-read 4 times
  const c = distinct[25] as Buffer; // re-read twice
  const messages: unknown[] = [{ role: "user", content: "x".repeat(600 * 1024) }]; // ~0.6 MB filler text
  for (const single of distinct.slice(0, 23)) messages.push(imageMessage(`turn ${messages.length}`, urlOf(single)));
  for (let i = 0; i < 17; i++) messages.push(imageMessage(`reread a ${i}`, urlOf(a)));
  for (let i = 0; i < 4; i++) messages.push(imageMessage(`reread b ${i}`, urlOf(b)));
  messages.push(imageMessage("reread c 0", urlOf(c)));
  messages.push(imageMessage("reread c 1", urlOf(c)));
  messages.push(imageMessage("current turn", urlOf(current)));
  assert.equal(messages.length, 48);

  // The hop measures the envelope (tools + model + stream) around messages.
  const tools = Array.from({ length: 40 }, (_, i) => ({
    type: "function",
    function: { name: `tool_${i}`, description: "d".repeat(5600), parameters: { type: "object", properties: {} } },
  }));
  const body = { model: "test-model", stream: false, tools, messages };
  const extraWireBytes = hopHandler.outboundEnvelopeBytes(body) + imageRead.WIRE_HEADROOM_BYTES;
  const toolsBytes = Buffer.byteLength(JSON.stringify(tools), "utf8");
  assert.ok(toolsBytes > 200 * 1024 && toolsBytes < 300 * 1024, `tools fixture ${toolsBytes} ~ incident's ~0.23 MB`);

  const out = (await imageRead.enforceImageBudget(messages, { convert: null, extraWireBytes })) as unknown[];

  // Dedup: 16 + 3 + 1 earlier identical copies become placeholders, and the
  // latest occurrence of each distinct image survives (then gets squeezed by
  // the history quota, so compare presence, not bytes).
  const dedupNotes = out.filter((m) => textPartsOf(m)[1] === imageRead.DEDUP_OMIT_PLACEHOLDER);
  assert.equal(dedupNotes.length, 20, "every earlier identical copy becomes a placeholder");
  assert.equal(partsOf(out[40]).some((p) => p.type === "image_url"), true, "latest copy of the 17x image is kept");
  assert.equal(partsOf(out[44]).some((p) => p.type === "image_url"), true, "latest copy of the 4x image is kept");
  assert.equal(partsOf(out[46]).some((p) => p.type === "image_url"), true, "latest copy of the 2x image is kept");
  assert.equal(partsOf(out[47]).some((p) => p.type === "image_url"), true, "current-turn image is kept");
  assert.equal(imageUrlOf(out[47]), urlOf(current), "current-turn image stays byte-identical");

  // History quota: every surviving history image is under the per-image target.
  for (let i = 1; i <= 46; i++) {
    const url = imageUrlOf(out[i]);
    if (!url) continue;
    assert.ok(
      decodedBytesOf(url) <= imageRead.HISTORY_IMAGE_TARGET_BYTES,
      `history image ${i} must be squeezed under the per-image target`,
    );
  }
  // No omission placeholders at all: dedup + the quotas must do this alone.
  for (const m of out) {
    assert.equal(textPartsOf(m).includes(imageRead.BUDGET_OMIT_PLACEHOLDER), false);
    assert.equal(textPartsOf(m).includes(imageRead.CURRENT_TURN_IMAGE_OMIT_PLACEHOLDER), false);
  }

  // The full outbound wire lands inside the calibrated worst-case target.
  const wire = Buffer.byteLength(JSON.stringify({ ...body, messages: out }), "utf8");
  assert.ok(wire <= 4.2 * 1024 * 1024, `wire ${wire} must stay under the 4.2 MB worst-case target`);
  assert.ok(wire >= 1.5 * 1024 * 1024, `wire ${wire} must not over-omit the deduped history`);
  // Text and tools must survive untouched: only images are governed.
  assert.equal(JSON.stringify(out).includes("x".repeat(600 * 1024)), true, "the text message survives");
});
