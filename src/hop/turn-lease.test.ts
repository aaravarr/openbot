import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const hopPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/hop-handler.cjs");
const hop = require(hopPath) as {
  handleHopRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
  finishReasonFromRaw: (raw: unknown) => string | undefined;
};

type Lease = {
  active: number;
  lastStartAt: number;
  lastEndAt: number;
  lastFinishReason?: string;
  updatedAt: number;
};

function listen(handler: http.RequestListener): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve({ server, port: addr.port });
    });
  });
}

function post(port: number, body: unknown, options: { stream?: boolean } = {}) {
  return new Promise<{ status: number; text: string; req: http.ClientRequest }>((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(payload.length) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8"), req }));
      },
    );
    req.on("error", (err) => {
      // A client abort is expected in one test; surface it as a rejection the
      // caller can ignore.
      reject(err);
    });
    if (options.stream) req.setHeader("Accept", "text/event-stream");
    req.end(payload);
  });
}

/** Poll the lease until it satisfies a predicate, so the counter can settle. */
async function waitForLease(leasePath: string, predicate: (lease: Lease) => boolean, label: string): Promise<Lease> {
  for (let i = 0; i < 100; i++) {
    let lease: Lease | undefined;
    try {
      lease = JSON.parse(readFileSync(leasePath, "utf8")) as Lease;
    } catch {
      lease = undefined;
    }
    if (lease && predicate(lease)) return lease;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`lease never satisfied: ${label}`);
}

type Fixture = {
  dir: string;
  leasePath: string;
  plan: string;
  hopPort: number;
  close: () => Promise<void>;
};

async function fixture(upstream: http.RequestListener): Promise<Fixture> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-turn-lease-"));
  const upstreamServer = await listen(upstream);
  const planPath = path.join(dir, "openbot-plan.json");
  writeFileSync(
    planPath,
    JSON.stringify({
      kind: "custom",
      catalog: {
        providers: [
          {
            id: "fixture",
            name: "Fixture",
            origin: `http://127.0.0.1:${String(upstreamServer.port)}/v1`,
            maxTokensDefault: 65536,
            mapFile: "provider-maps.cjs",
          },
        ],
        models: [{ id: "fixture:m", providerId: "fixture", slug: "m", parameters: [] }],
        bindings: [{ conversation: { kind: "wildcard" }, modelId: "fixture:m" }],
      },
    }),
  );
  writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({ providers: { fixture: "sk-test" } }));
  writeFileSync(path.join(dir, "openbot-logs.json"), JSON.stringify({ loggingEnabled: false }));

  const hopServer = await listen((req, res) => {
    void hop.handleHopRequest(req, res).then((handled) => {
      if (!handled && !res.headersSent) {
        res.writeHead(404);
        res.end();
      }
    });
  });

  const prev = {
    plan: process.env.OPENBOT_PLAN,
    secrets: process.env.OPENBOT_SECRETS,
    sand: process.env.OPENBOT_SAND_DATA,
    logs: process.env.OPENBOT_LOGS,
    lease: process.env.OPENBOT_TURN_LEASE,
  };
  process.env.OPENBOT_PLAN = planPath;
  process.env.OPENBOT_SECRETS = path.join(dir, "secrets.json");
  process.env.OPENBOT_SAND_DATA = dir;
  process.env.OPENBOT_LOGS = path.join(dir, "openbot-logs.json");
  delete process.env.OPENBOT_TURN_LEASE;

  return {
    dir,
    leasePath: path.join(dir, "openbot-turn-lease.json"),
    plan: planPath,
    hopPort: hopServer.port,
    close: async () => {
      hopServer.server.close();
      hopServer.server.closeAllConnections();
      upstreamServer.server.close();
      upstreamServer.server.closeAllConnections();
      rmSync(dir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(prev)) {
        const envKey = {
          plan: "OPENBOT_PLAN",
          secrets: "OPENBOT_SECRETS",
          sand: "OPENBOT_SAND_DATA",
          logs: "OPENBOT_LOGS",
          lease: "OPENBOT_TURN_LEASE",
        }[key] as string;
        if (value === undefined) delete process.env[envKey];
        else process.env[envKey] = value;
      }
    },
  };
}

const BODY = { model: "m", messages: [{ role: "user", content: "hello" }] };

test("finishReasonFromRaw reads the last finish_reason of both response shapes", () => {
  assert.equal(hop.finishReasonFromRaw(Buffer.from('data: {"choices":[{"finish_reason":null}]}\n\ndata: {"choices":[{"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n')), "tool_calls");
  assert.equal(hop.finishReasonFromRaw('{"choices":[{"finish_reason":"stop"}]}'), "stop");
  assert.equal(hop.finishReasonFromRaw("not json"), undefined);
  assert.equal(hop.finishReasonFromRaw(undefined), undefined);
});

test("a non-stream success records the answer and releases the lease", async () => {
  const ctx = await fixture((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"choices":[{"message":{"role":"assistant","content":"hi"},"finish_reason":"stop"}]}');
  });
  try {
    const response = await post(ctx.hopPort, BODY);
    assert.equal(response.status, 200);
    const lease = await waitForLease(ctx.leasePath, (row) => row.active === 0 && row.lastFinishReason === "stop", "settled stop");
    assert.equal(lease.active, 0);
    assert.ok(lease.lastEndAt >= lease.lastStartAt);
  } finally {
    await ctx.close();
  }
});

test("a streamed tool call keeps the lease busy until it settles, then records tool_calls", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ctx = await fixture(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"think"}}]}\n\n');
    await gate;
    res.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });
  try {
    const pending = post(ctx.hopPort, { ...BODY, stream: true });
    const busy = await waitForLease(ctx.leasePath, (row) => row.active === 1, "active request");
    assert.equal(busy.active, 1);
    release?.();
    const response = await pending;
    assert.equal(response.status, 200);
    const settled = await waitForLease(ctx.leasePath, (row) => row.active === 0 && row.lastFinishReason === "tool_calls", "tool call settled");
    assert.equal(settled.lastFinishReason, "tool_calls");
  } finally {
    release?.();
    await ctx.close();
  }
});

test("an upstream failure still releases the lease", async () => {
  const ctx = await fixture((_req, res) => {
    res.writeHead(400, { "content-type": "application/json" });
    res.end('{"error":{"message":"nope"}}');
  });
  try {
    const response = await post(ctx.hopPort, BODY);
    assert.equal(response.status, 400);
    const lease = await waitForLease(ctx.leasePath, (row) => row.active === 0, "released after 400");
    assert.equal(lease.active, 0);
  } finally {
    await ctx.close();
  }
});

test("a client that goes away mid-request still releases the lease", async () => {
  const ctx = await fixture(async (_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"start"}}]}\n\n');
    // Never finishes on its own: the client abort drives the release.
  });
  try {
    const payload = Buffer.from(JSON.stringify({ ...BODY, stream: true }));
    const req = http.request(
      {
        host: "127.0.0.1",
        port: ctx.hopPort,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(payload.length) },
      },
      () => {
        /* headers only; the body never ends */
      },
    );
    req.on("error", () => {
      /* expected: the socket is destroyed below */
    });
    req.end(payload);
    await waitForLease(ctx.leasePath, (row) => row.active === 1, "in flight");
    req.destroy();
    const lease = await waitForLease(ctx.leasePath, (row) => row.active === 0, "released after client abort");
    assert.equal(lease.active, 0);
    assert.equal(lease.active >= 0, true);
  } finally {
    await ctx.close();
  }
});

test("a lease write failure never breaks the chat path", async () => {
  const ctx = await fixture((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}');
  });
  // A lease path inside a directory that does not exist: every write fails.
  process.env.OPENBOT_TURN_LEASE = path.join(ctx.dir, "missing-dir", "openbot-turn-lease.json");
  try {
    const response = await post(ctx.hopPort, BODY);
    assert.equal(response.status, 200);
  } finally {
    delete process.env.OPENBOT_TURN_LEASE;
    await ctx.close();
  }
});

test("the lease file is written atomically: valid JSON and no temp file left behind", async () => {
  const ctx = await fixture((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"choices":[{"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}');
  });
  try {
    const response = await post(ctx.hopPort, BODY);
    assert.equal(response.status, 200);
    await waitForLease(ctx.leasePath, (row) => row.active === 0, "settled");
    const lease = JSON.parse(readFileSync(ctx.leasePath, "utf8")) as Lease;
    assert.equal(lease.active, 0);
    assert.equal(typeof lease.updatedAt, "number");
    const leftovers = readdirSync(ctx.dir).filter((name) => name.includes(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    await ctx.close();
  }
});
