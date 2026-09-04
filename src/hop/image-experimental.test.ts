import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const imageRead = require(path.join(here, "../../payload/image-read.cjs")) as {
  enrichImageReads: (messages: unknown) => Promise<ExpMessage[]>;
  extractExperimentalImageUrls: (value: unknown) => { url: string; mime: string }[];
  experimentalContentRaw: (record: unknown) => unknown;
};
const { toOpenAIMessages } = require(path.join(here, "../../payload/openai-messages.cjs")) as {
  toOpenAIMessages: (msgs: unknown) => ExpMessage[];
};

type ContentPart = { type: string; text?: string; image_url?: { url: string } };

type ExpMessage = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: { id: string; type: string; function: { name: string; arguments: string } }[];
};

// 1x1 transparent PNG (68 bytes) and 1x1 JPEG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");
const PNG_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;
const JPEG_DATA_URL =
  "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPDUzNDP/wAALCAABAAEBAREA/8QAFAABAQAAAAAAAAAAAAAAAAAAAAv/2gAIAQEAAD8A0s8g/9k=";

let dir = "";
test.before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "openbot-image-experimental-"));
});

test.after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

// A path that does not exist on any OS the tests run on.
function missingPngPath(): string {
  return path.join(dir, "missing-on-disk.png");
}

function readCall(id: string, name: string, args: string): ExpMessage {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
  };
}

function hostTurnWithExperimental(experimental: unknown, toolName = "Read", callId = "call_1"): ExpMessage[] {
  return [
    { role: "user", content: "look at the screenshot" },
    readCall(callId, toolName, JSON.stringify({ path: missingPngPath() })),
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: callId, result: "Read image file", experimental_content: experimental },
      ],
    },
    { role: "user", content: "what does it show" },
  ];
}

function imagePartsOf(out: ExpMessage[]): { msg: ExpMessage; parts: ContentPart[] }[] {
  const hits: { msg: ExpMessage; parts: ContentPart[] }[] = [];
  for (const msg of out) {
    if (!Array.isArray(msg.content)) continue;
    const parts = msg.content as ContentPart[];
    if (parts.some((p) => p.type === "image_url")) hits.push({ msg, parts });
  }
  return hits;
}

test("tool-result experimental_content bytes are injected and the disk is never read", async () => {
  const out = await imageRead.enrichImageReads(toOpenAIMessages(hostTurnWithExperimental({
    type: "image",
    data: PNG_BASE64,
    mimeType: "image/png",
  })));

  assert.equal(out.length, 5);
  assert.equal(out[2]?.role, "tool");
  assert.equal(out[3]?.role, "user");
  const parts = out[3]?.content as ContentPart[];
  assert.equal(parts[0]?.type, "text");
  assert.equal(parts[0]?.text, `[Image attached from Read: ${missingPngPath()}]`);
  assert.equal(parts[1]?.type, "image_url");
  assert.equal(parts[1]?.image_url?.url, PNG_DATA_URL);
  assert.equal(out[4]?.role, "user");
});

test("experimentalContent alias and message-level experimental_content both map", async () => {
  const aliased = hostTurnWithExperimental({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
  const part = (aliased[2]?.content as { experimental_content?: unknown }[] | undefined)?.[0];
  if (part) delete part.experimental_content;
  (aliased[2] as { experimentalContent?: unknown }).experimentalContent = {
    type: "image",
    data: PNG_BASE64,
    mimeType: "image/png",
  };
  const out = await imageRead.enrichImageReads(toOpenAIMessages(aliased));
  assert.equal(imagePartsOf(out).length, 1);

  // Message-level fallback on a plain tool message.
  const messageLevel = [
    readCall("call_9", "Read", JSON.stringify({ path: missingPngPath() })),
    { role: "tool", tool_call_id: "call_9", content: "done", experimental_content: PNG_DATA_URL },
  ];
  const out2 = await imageRead.enrichImageReads(toOpenAIMessages(messageLevel));
  assert.equal(out2.length, 3);
  assert.equal(imagePartsOf(out2).length, 1);
  assert.equal((imagePartsOf(out2)[0]?.parts[1] as ContentPart).image_url?.url, PNG_DATA_URL);
});

test("an experimental_content array injects one user message per image", async () => {
  const out = await imageRead.enrichImageReads(toOpenAIMessages(hostTurnWithExperimental([
    { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    { type: "image", image: JPEG_DATA_URL },
  ])));
  assert.equal(out.length, 6);
  assert.equal(out[3]?.role, "user");
  assert.equal(out[4]?.role, "user");
  assert.equal(out[5]?.role, "user");
  const parts3 = out[3]?.content as ContentPart[];
  const parts4 = out[4]?.content as ContentPart[];
  assert.equal(parts3[1]?.image_url?.url, PNG_DATA_URL);
  assert.equal(parts4[1]?.image_url?.url, JPEG_DATA_URL);
});

test("identical experimental images are injected once, not twice", async () => {
  const out = await imageRead.enrichImageReads(toOpenAIMessages(hostTurnWithExperimental([
    { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    { type: "image", image: PNG_DATA_URL },
  ])));
  assert.equal(out.length, 5);
  assert.equal(imagePartsOf(out).length, 1);
});

test("a second toOpenAIMessages pass does not duplicate the injected image", async () => {
  const first = toOpenAIMessages(hostTurnWithExperimental({
    type: "image",
    data: PNG_BASE64,
    mimeType: "image/png",
  }));
  const second = toOpenAIMessages(first);
  const out = await imageRead.enrichImageReads(second);
  assert.equal(imagePartsOf(out).length, 1);
  const serialized = JSON.stringify(out);
  assert.equal(serialized.includes("experimental_content"), false);
  assert.equal(serialized.includes("experimentalContent"), false);
});

test("carried experimental keys are stripped even when nothing is injected", async () => {
  // Result text already carries image data: nothing may be injected, and the
  // carried field must still disappear from the outbound rows.
  const withImageData = hostTurnWithExperimental({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
  const resultPart = (withImageData[2]?.content as { result?: unknown }[] | undefined)?.[0];
  if (resultPart) resultPart.result = "data:image/png;base64,AAAA already in text";
  const out = await imageRead.enrichImageReads(toOpenAIMessages(withImageData));
  assert.equal(imagePartsOf(out).length, 0);
  assert.equal(JSON.stringify(out).includes("experimental_content"), false);
});

test("non-Read tool results with experimental image bytes are mapped too", async () => {
  const out = await imageRead.enrichImageReads(toOpenAIMessages([
    readCall("call_2", "Screenshot", JSON.stringify({ region: "full" })),
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_2", result: "captured", experimental_content: {
          type: "image",
          data: PNG_BASE64,
          mimeType: "image/png",
        } },
      ],
    },
  ]));
  assert.equal(out.length, 3);
  assert.equal(out[2]?.role, "user");
  const parts = out[2]?.content as ContentPart[];
  assert.equal(parts[0]?.text, "[Image attached from tool result]");
  assert.equal(parts[1]?.image_url?.url, PNG_DATA_URL);
});

test("experimental content without image entries falls back to the disk read", async () => {
  const file = path.join(dir, "fallback.png");
  writeFileSync(file, PNG_BYTES);
  const messages: ExpMessage[] = [
    readCall("call_3", "Read", JSON.stringify({ path: file })),
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_3", result: "Read image file", experimental_content: {
          type: "text",
          text: "only text here",
        } },
      ],
    },
  ];
  const out = await imageRead.enrichImageReads(toOpenAIMessages(messages));
  assert.equal(out.length, 3);
  assert.equal(out[2]?.role, "user");
  const parts = out[2]?.content as ContentPart[];
  assert.equal(parts[1]?.image_url?.url, PNG_DATA_URL);
});

test("extractExperimentalImageUrls probes aliases, arrays, data URLs, and raw bytes", () => {
  const single = imageRead.extractExperimentalImageUrls({ type: "image", data: PNG_BASE64, mimeType: "image/png" });
  assert.equal(single.length, 1);
  assert.equal(single[0]?.url, PNG_DATA_URL);
  assert.equal(single[0]?.mime, "image/png");

  const dataUrl = imageRead.extractExperimentalImageUrls({ type: "image", image: PNG_DATA_URL });
  assert.equal(dataUrl.length, 1);
  assert.equal(dataUrl[0]?.url, PNG_DATA_URL);

  const bytes = imageRead.extractExperimentalImageUrls({ type: "image", image: PNG_BYTES });
  assert.equal(bytes.length, 1);
  assert.equal(bytes[0]?.url, PNG_DATA_URL);

  const anthropic = imageRead.extractExperimentalImageUrls({
    type: "image",
    source: { type: "base64", media_type: "image/png", data: PNG_BASE64 },
  });
  assert.equal(anthropic.length, 1);
  assert.equal(anthropic[0]?.url, PNG_DATA_URL);

  const mixed = imageRead.extractExperimentalImageUrls([
    { type: "text", text: "ignore me" },
    { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    "not image data",
  ]);
  assert.equal(mixed.length, 1);

  const duplicated = imageRead.extractExperimentalImageUrls([
    { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    { type: "image", image: PNG_DATA_URL },
  ]);
  assert.equal(duplicated.length, 1);

  assert.equal(imageRead.extractExperimentalImageUrls(undefined).length, 0);
  assert.equal(imageRead.extractExperimentalImageUrls({ type: "image", data: "!!!not-base64!!!" }).length, 0);
});

test("experimentalContentRaw probes the known aliases", () => {
  assert.equal(imageRead.experimentalContentRaw({ experimental_content: 1 }), 1);
  assert.equal(imageRead.experimentalContentRaw({ experimentalContent: 2 }), 2);
  assert.equal(imageRead.experimentalContentRaw({ experimental_contents: 3 }), 3);
  assert.equal(imageRead.experimentalContentRaw({ experimentalContents: 4 }), 4);
  assert.equal(imageRead.experimentalContentRaw({ other: 5 }), undefined);
  assert.equal(imageRead.experimentalContentRaw("nope"), undefined);
});
