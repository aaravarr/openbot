import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import type http from "node:http";
import test from "node:test";
import { handleBotModelsApi } from "./bot-models.ts";

function request(method: string, body?: unknown): http.IncomingMessage {
  const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as Readable & { method: string; url: string };
  req.method = method;
  req.url = "/api/bot-models";
  return req as unknown as http.IncomingMessage;
}

function response(): { value: { status: number; body: unknown }; res: any } {
  const value = { status: 0, body: undefined as unknown };
  const res = {
    writeHead(status: number) { value.status = status; },
    end(body: string) { value.body = JSON.parse(body); },
  };
  return { value, res };
}

test("bot model API validates models and supports clearing and replacement", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-ui-bot-models-"));
  const file = path.join(root, "openbot-bot-models.json");
  const previous = process.env.OPENBOT_BOT_MODELS;
  process.env.OPENBOT_BOT_MODELS = file;
  const current = {
    paths: { sandData: root, plan: path.join(root, "openbot-plan.json") },
    fs: { read: () => undefined },
  } as any;
  const catalog = { providers: [], bindings: [], models: [{ id: "provider:model" }] } as any;
  const readBody = async (req: Readable) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString(); };
  try {
    const bad = response();
    await handleBotModelsApi(request("PUT", { botId: "bot-1", modelId: "missing" }), bad.res, new URL("http://localhost/api/bot-models"), current, readBody, (res, status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); }, () => catalog);
    assert.equal(bad.value.status, 400);
    const set = response();
    await handleBotModelsApi(request("PUT", { botId: "bot-1", modelId: "provider:model" }), set.res, new URL("http://localhost/api/bot-models"), current, readBody, (res, status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); }, () => catalog);
    assert.equal(set.value.status, 200);
    const clear = response();
    await handleBotModelsApi(request("PUT", { botId: "bot-1", modelId: null }), clear.res, new URL("http://localhost/api/bot-models"), current, readBody, (res, status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); }, () => catalog);
    assert.deepEqual((clear.value.body as any).assignments, {});
    const replace = response();
    await handleBotModelsApi(request("PUT", { assignments: { "bot-2": "provider:model" } }), replace.res, new URL("http://localhost/api/bot-models"), current, readBody, (res, status, body) => { res.writeHead(status); res.end(JSON.stringify(body)); }, () => catalog);
    assert.deepEqual((replace.value.body as any).assignments, { "bot-2": "provider:model" });
  } finally {
    if (previous === undefined) delete process.env.OPENBOT_BOT_MODELS;
    else process.env.OPENBOT_BOT_MODELS = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
