import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agent-box", "install.sh");

function run(args: string[], env: NodeJS.ProcessEnv, timeout = 15000) {
  return spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    timeout,
    env: { ...process.env, ...env },
  });
}

function httpReq(
  url: string,
  opts: { method?: string; json?: unknown; raw?: Buffer; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const body = opts.raw ?? (opts.json !== undefined ? Buffer.from(JSON.stringify(opts.json)) : undefined);
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
    }
    if (body) {
      headers["content-length"] = String(body.length);
    }
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: opts.method ?? "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.on("error", reject);
    if (body) {
      req.end(body);
    } else {
      req.end();
    }
  });
}

test("agent-box refuses OpenBot port 9280", () => {
  const result = run(["start"], {
    AGENT_BOX_PORT: "9280",
    AGENT_BOX_SKIP_TUNNEL: "1",
    AGENT_BOX_DATA: mkdtempSync(path.join(os.tmpdir(), "agent-box-9280-")),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /9280/);
});

test("agent-box --help mentions the one-line install", () => {
  const result = run(["--help"], {});
  assert.equal(result.status, 0);
  assert.match(result.stderr, /curl -fsSL/);
  assert.match(result.stderr, /agent-box\/install\.sh/);
});

test("agent-box serves docs, exec, and files on loopback", async () => {
  const data = mkdtempSync(path.join(os.tmpdir(), "agent-box-live-"));
  const port = String(19000 + Math.floor(Math.random() * 500));
  const env = {
    AGENT_BOX_DATA: data,
    AGENT_BOX_PORT: port,
    AGENT_BOX_SKIP_TUNNEL: "1",
    AGENT_BOX_JSON: "1",
  };
  try {
    const started = run(["start"], env);
    assert.equal(started.status, 0, started.stderr || started.stdout);
    const parsed = JSON.parse(started.stdout.trim()) as { url: string; internal: string };
    assert.match(parsed.url, new RegExp(`http://127\\.0\\.0\\.1:${port}/v/[a-f0-9]+`));
    assert.equal(parsed.internal, `http://127.0.0.1:${port}`);

    const docs = await httpReq(`${parsed.url}/`);
    assert.equal(docs.status, 200);
    assert.match(docs.body, /POST \$\{base\}\/exec|POST https?:\/\/.+\/exec|POST .+\/exec/);
    assert.match(docs.body, /\/exec/);
    assert.match(docs.body, /Anyone who has it can run commands/);

    const anon = await httpReq(`http://127.0.0.1:${port}/`);
    assert.equal(anon.status, 401);

    const wrong = await httpReq(`http://127.0.0.1:${port}/v/deadbeef/health`);
    assert.equal(wrong.status, 401);

    const health = await httpReq(`${parsed.url}/health`);
    assert.equal(health.status, 200);
    const info = JSON.parse(health.body) as { ok: boolean; user: string };
    assert.equal(info.ok, true);
    assert.equal(typeof info.user, "string");

    const exec = await httpReq(`${parsed.url}/exec`, { method: "POST", json: { cmd: "echo agent-box-ok" } });
    assert.equal(exec.status, 200);
    const out = JSON.parse(exec.body) as { ok: boolean; stdout: string; code: number };
    assert.equal(out.ok, true);
    assert.equal(out.code, 0);
    assert.match(out.stdout, /agent-box-ok/);

    const argv = await httpReq(`${parsed.url}/exec`, { method: "POST", json: { argv: ["node", "-e", "process.stdout.write('argv-ok')"] } });
    assert.equal(JSON.parse(argv.body).stdout, "argv-ok");

    const target = path.join(data, "note.txt");
    const put = await httpReq(`${parsed.url}/fs?path=${encodeURIComponent(target)}`, {
      method: "PUT",
      json: { text: "hello-agent" },
    });
    assert.equal(put.status, 200);
    assert.equal(readFileSync(target, "utf8"), "hello-agent");
    const got = await httpReq(`${parsed.url}/fs?path=${encodeURIComponent(target)}`);
    assert.equal(JSON.parse(got.body).body, "hello-agent");

    const again = run(["start"], env);
    assert.equal(again.status, 0, again.stderr || again.stdout);
    const reused = JSON.parse(again.stdout.trim()) as { url: string };
    assert.equal(reused.url, parsed.url);

    const stopped = run(["stop"], env);
    assert.equal(stopped.status, 0, stopped.stderr);
    const dead = await httpReq(`${parsed.url}/health`).then(
      (row) => row.status,
      () => 0,
    );
    assert.notEqual(dead, 200);
  } finally {
    run(["stop"], env);
    rmSync(data, { recursive: true, force: true });
  }
});
