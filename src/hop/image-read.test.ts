import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const imageRead = require(path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/image-read.cjs")) as {
  enrichImageReads: (messages: unknown) => Promise<unknown[]>;
  isImageReadToolName: (name: unknown) => boolean;
  filePathFromArgs: (args: unknown) => string;
  contentHasImageData: (content: unknown) => boolean;
  imageExtOf: (filePath: unknown) => string;
  MAX_IMAGE_BYTES: number;
};

type ToolCall = {
  id: string;
  type: string;
  function: { name: string; arguments: string };
};

type Message = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

// 1x1 transparent PNG (68 bytes).
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

let dir = "";
test.before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "openbot-image-read-"));
});

test.after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function pngPath(): string {
  const file = path.join(dir, "pixel.png");
  writeFileSync(file, PNG_BYTES);
  return file;
}

function readCall(id: string, name: string, args: string): Message {
  return {
    role: "assistant",
    content: "",
    tool_calls: [{ id, type: "function", function: { name, arguments: args } }],
  };
}

function toolResult(id: string, content: unknown): Message {
  return { role: "tool", tool_call_id: id, content };
}

test("image read injects a user message with a data URI after the tool result", async () => {
  const file = pngPath();
  const messages: Message[] = [
    { role: "user", content: "look at this" },
    readCall("call_1", "Read", JSON.stringify({ path: file })),
    toolResult("call_1", "no image data here"),
    { role: "user", content: "continue" },
  ];
  const out = (await imageRead.enrichImageReads(messages)) as Message[];

  assert.equal(out.length, 5);
  assert.equal(out[0]?.role, "user");
  assert.equal(out[1]?.role, "assistant");
  assert.equal(out[2]?.role, "tool");
  assert.equal(out[3]?.role, "user");

  const parts = out[3]?.content as { type: string; text?: string; image_url?: { url: string } }[];
  assert.equal(Array.isArray(parts), true);
  assert.equal(parts[0]?.type, "text");
  assert.equal(parts[0]?.text, `[Image attached from Read: ${file}]`);
  assert.equal(parts[1]?.type, "image_url");
  assert.equal(parts[1]?.image_url?.url, `data:image/png;base64,${PNG_BYTES.toString("base64")}`);

  assert.equal(out[4]?.role, "user");
  assert.equal(out[4]?.content, "continue");
});

test("tool result already containing image_url is not double-injected", async () => {
  const file = pngPath();
  const messages: Message[] = [
    { role: "user", content: "look at this" },
    readCall("call_1", "Read", JSON.stringify({ path: file })),
    toolResult("call_1", JSON.stringify({ image_url: "data:image/png;base64,AAAA" })),
  ];
  const out = (await imageRead.enrichImageReads(messages)) as Message[];
  assert.equal(out.length, 3);
  assert.equal(out[2]?.role, "tool");
});

test("text Read with a .txt path is untouched", async () => {
  const file = path.join(dir, "notes.txt");
  writeFileSync(file, "hello");
  const messages: Message[] = [
    { role: "user", content: "read it" },
    readCall("call_1", "Read", JSON.stringify({ path: file })),
    toolResult("call_1", "hello"),
  ];
  const out = (await imageRead.enrichImageReads(messages)) as Message[];
  assert.equal(out.length, 3);
  assert.equal(out[2]?.role, "tool");
  assert.equal(out[2]?.content, "hello");
});

test("missing image file is skipped without throwing", async () => {
  const file = path.join(dir, "does-not-exist.png");
  const messages: Message[] = [
    { role: "user", content: "look" },
    readCall("call_1", "Read", JSON.stringify({ path: file })),
    toolResult("call_1", "empty"),
  ];
  const out = (await imageRead.enrichImageReads(messages)) as Message[];
  assert.equal(out.length, 3);
  assert.equal(out[2]?.role, "tool");
});

test("non-Read tool with an image-ish path is untouched", async () => {
  const file = pngPath();
  const messages: Message[] = [
    { role: "user", content: "run it" },
    readCall("call_1", "Bash", JSON.stringify({ command: `cat ${file}` })),
    toolResult("call_1", "ok"),
  ];
  const out = (await imageRead.enrichImageReads(messages)) as Message[];
  assert.equal(out.length, 3);
  assert.equal(out[2]?.role, "tool");
});

test("read_image variant with file_path key injects", async () => {
  const file = pngPath();
  const messages: Message[] = [
    { role: "user", content: "look" },
    readCall("call_2", "ReadImage", JSON.stringify({ file_path: file })),
    toolResult("call_2", "result"),
  ];
  const out = (await imageRead.enrichImageReads(messages)) as Message[];
  assert.equal(out.length, 4);
  assert.equal(out[3]?.role, "user");
  const parts = out[3]?.content as { type: string; image_url?: { url: string } }[];
  assert.equal(parts[1]?.type, "image_url");
  assert.equal(parts[1]?.image_url?.url, `data:image/png;base64,${PNG_BYTES.toString("base64")}`);
});

test("file over the 20 MB guard is skipped", async () => {
  const big = path.join(dir, "big.png");
  writeFileSync(big, Buffer.alloc(imageRead.MAX_IMAGE_BYTES + 1, 1));
  const messages: Message[] = [
    { role: "user", content: "look" },
    readCall("call_1", "Read", JSON.stringify({ path: big })),
    toolResult("call_1", "result"),
  ];
  const out = (await imageRead.enrichImageReads(messages)) as Message[];
  assert.equal(out.length, 3);
  assert.equal(out[2]?.role, "tool");
});

test("helpers recognize read names, image extensions, and existing image data", () => {
  assert.equal(imageRead.isImageReadToolName("Read"), true);
  assert.equal(imageRead.isImageReadToolName("read"), true);
  assert.equal(imageRead.isImageReadToolName("read_image"), true);
  assert.equal(imageRead.isImageReadToolName("ReadImage"), true);
  assert.equal(imageRead.isImageReadToolName("Bash"), false);

  assert.equal(imageRead.imageExtOf("/a/b.PNG"), "png");
  assert.equal(imageRead.imageExtOf("/a/b.jpeg"), "jpeg");
  assert.equal(imageRead.imageExtOf("/a/b.txt"), "");

  assert.equal(imageRead.filePathFromArgs('{"path":"/tmp/x.png"}'), "/tmp/x.png");
  assert.equal(imageRead.filePathFromArgs('{"file_path":"/tmp/y.jpg"}'), "/tmp/y.jpg");
  assert.equal(imageRead.filePathFromArgs('{"path":"/tmp/z.txt"}'), "/tmp/z.txt");

  assert.equal(imageRead.contentHasImageData('{"image_url":"data:image/png;base64,AA"}'), true);
  assert.equal(imageRead.contentHasImageData("data:image/webp;base64,AA"), true);
  assert.equal(imageRead.contentHasImageData("plain text result"), false);
});
