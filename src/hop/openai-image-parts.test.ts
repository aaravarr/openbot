import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { toOpenAIMessages } = require(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/openai-messages.cjs")) as {
  toOpenAIMessages: (msgs: unknown) => OpenAiMessage[];
};

type ContentPart = {
  type: string;
  text?: string;
  image_url?: { url: string };
};

type OpenAiMessage = {
  role: string;
  content?: string | ContentPart[];
};

// 1x1 transparent PNG (68 bytes).
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

let dir = "";
test.before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "openbot-image-parts-"));
});

test.after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function partsOf(out: OpenAiMessage[]): ContentPart[] {
  assert.equal(out.length, 1);
  const content = out[0]?.content;
  assert.equal(Array.isArray(content), true);
  return content as ContentPart[];
}

test("host image part with base64 + mime becomes an image_url content part", () => {
  const out = toOpenAIMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "look at this" },
        { type: "image", mime: "image/png", data: PNG_BASE64 },
      ],
    },
  ]);
  const parts = partsOf(out);
  assert.equal(parts[0]?.type, "text");
  assert.equal(parts[0]?.text, "look at this");
  assert.equal(parts[1]?.type, "image_url");
  assert.equal(parts[1]?.image_url?.url, `data:image/png;base64,${PNG_BASE64}`);
});

test("host image part with bare base64 is sniffed by magic bytes", () => {
  const out = toOpenAIMessages([
    { role: "user", content: [{ type: "image", base64: PNG_BASE64 }] },
  ]);
  const parts = partsOf(out);
  assert.equal(parts[0]?.type, "image_url");
  assert.equal(parts[0]?.image_url?.url, `data:image/png;base64,${PNG_BASE64}`);
});

test("host image part with a data: URI url is used as-is", () => {
  const dataUrl = `data:image/png;base64,${PNG_BASE64}`;
  const out = toOpenAIMessages([
    { role: "user", content: [{ type: "image", url: dataUrl }] },
  ]);
  const parts = partsOf(out);
  assert.equal(parts[0]?.type, "image_url");
  assert.equal(parts[0]?.image_url?.url, dataUrl);
});

test("host image part with an http(s) url is used as-is", () => {
  const out = toOpenAIMessages([
    { role: "user", content: [{ type: "image", url: "https://example.com/pixel.png" }] },
  ]);
  const parts = partsOf(out);
  assert.equal(parts[0]?.type, "image_url");
  assert.equal(parts[0]?.image_url?.url, "https://example.com/pixel.png");
});

test("host image part with a local path reads the file and injects a data URI", () => {
  const file = path.join(dir, "pixel.png");
  writeFileSync(file, PNG_BYTES);
  const out = toOpenAIMessages([
    { role: "user", content: [{ type: "image", path: file }] },
  ]);
  const parts = partsOf(out);
  assert.equal(parts[0]?.type, "image_url");
  assert.equal(parts[0]?.image_url?.url, `data:image/png;base64,${PNG_BASE64}`);
});

test("host image part with no usable fields falls back to the [image] placeholder", () => {
  const out = toOpenAIMessages([
    { role: "user", content: [{ type: "image", foo: "bar" }] },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.role, "user");
  assert.equal(out[0]?.content, "[image]");
});

test("a user turn with text and an image injects both in a single user message", () => {
  const out = toOpenAIMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "image", data: `data:image/png;base64,${PNG_BASE64}` },
      ],
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.role, "user");
  const parts = partsOf(out);
  assert.equal(parts.length, 2);
  assert.equal(parts[0]?.type, "text");
  assert.equal(parts[0]?.text, "what is this");
  assert.equal(parts[1]?.type, "image_url");
  assert.equal(parts[1]?.image_url?.url, `data:image/png;base64,${PNG_BASE64}`);
});

test("text-only content still converts to a plain string, not an array", () => {
  const out = toOpenAIMessages([{ role: "user", content: "plain text" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.content, "plain text");
});

test("a second toOpenAIMessages pass preserves image_url content (runtime -> hop)", () => {
  const host = [
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", mime: "image/png", data: PNG_BASE64 },
      ],
    },
  ];
  const first = toOpenAIMessages(host);
  const second = toOpenAIMessages(first);
  assert.equal(second.length, 1);
  const parts = partsOf(second);
  assert.equal(parts[0]?.type, "text");
  assert.equal(parts[0]?.text, "look");
  assert.equal(parts[1]?.type, "image_url");
  assert.equal(parts[1]?.image_url?.url, `data:image/png;base64,${PNG_BASE64}`);
});
