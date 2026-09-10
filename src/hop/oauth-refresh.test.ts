import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const hopPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/hop-handler.cjs");
const hop = createRequire(import.meta.url)(hopPath) as { loadKey: (providerId: string, provider: unknown) => Promise<string>; resolveUpstreamUrl: (provider: { origin: string }, oauth: boolean, apiType: string) => string };

function expiredCredential(): string {
  return JSON.stringify({ kind: "openai-oauth", accessToken: "old-access", refreshToken: "refresh", expiresAt: 1 });
}

test("OpenAI OAuth resolves to the ChatGPT Codex Responses upstream", () => {
  assert.equal(hop.resolveUpstreamUrl({ origin: "https://api.openai.com/v1" }, true, "responses"), "https://chatgpt.com/backend-api/codex/responses");
  assert.equal(hop.resolveUpstreamUrl({ origin: "https://api.openai.com/v1" }, false, "chat-completions"), "https://api.openai.com/v1/chat/completions");
});

function installRefreshStub(t: test.TestContext, body: object): { calls: () => number } {
  let calls = 0;
  t.mock.method(https, "request", ((_options: unknown, callback: (response: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void) => {
    calls += 1;
    const request = new EventEmitter() as EventEmitter & { setTimeout: (ms: number, fn: () => void) => void; write: (value: Buffer) => void; end: () => void; destroy: () => void };
    request.setTimeout = () => undefined;
    request.write = () => undefined;
    request.destroy = () => undefined;
    request.end = () => {
      const response = new EventEmitter() as EventEmitter & { statusCode: number; headers: Record<string, string> };
      response.statusCode = 200;
      response.headers = {};
      callback(response);
      queueMicrotask(() => {
        response.emit("data", Buffer.from(JSON.stringify(body)));
        response.emit("end");
      });
    };
    return request;
  }) as never);
  return { calls: () => calls };
}

function withSecretsFile(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-oauth-refresh-"));
  const file = path.join(dir, "secrets.json");
  process.env.OPENBOT_SECRETS = file;
  fs.writeFileSync(file, JSON.stringify({ providers: { openai: expiredCredential() } }));
  t.after(() => {
    delete process.env.OPENBOT_SECRETS;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return file;
}

test("concurrent expired OAuth requests share one refresh and both use the new token", async (t) => {
  withSecretsFile(t);
  const stub = installRefreshStub(t, { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
  const [first, second] = await Promise.all([hop.loadKey("openai", {}), hop.loadKey("openai", {})]);
  assert.equal(stub.calls(), 1);
  assert.equal(first, "new-access");
  assert.equal(second, "new-access");
});

test("concurrent OAuth refreshes fail closed when credential persistence fails", async (t) => {
  withSecretsFile(t);
  const stub = installRefreshStub(t, { access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
  const originalWriteFileSync = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", ((file: fs.PathLike, ...args: unknown[]) => {
    if (String(file).endsWith(".tmp")) throw new Error("read-only secrets");
    return (originalWriteFileSync as unknown as (...values: unknown[]) => unknown)(file, ...args);
  }) as never);
  const results = await Promise.allSettled([hop.loadKey("openai", {}), hop.loadKey("openai", {})]);
  assert.equal(stub.calls(), 1);
  assert.equal(results[0]?.status, "rejected");
  assert.equal(results[1]?.status, "rejected");
  assert.match(String((results[0] as PromiseRejectedResult).reason), /not persisted/);
  assert.match(fs.readFileSync(process.env.OPENBOT_SECRETS!, "utf8"), /old-access/);
});
