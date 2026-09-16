import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Conversation identity for the delivery-follow-up gate on the custom wrap
 * path. The wrap (payload/runtime.cjs) stamps the hop body with
 * conversationId + epochId; these tests prove the identity actually arms
 * the observable fallback lane (identityGate pass, non-empty stateKey, L2
 * eligible under enforce), that the mirror fields NEVER reach the upstream
 * provider's wire bytes, and that the honest skip reasons survive for
 * turns without identity.
 *
 * Every case drives the real loopback hop handler against a stub upstream
 * and asserts only client-observable facts: upstream call count, the exact
 * upstream request body, and the request-log rows.
 */

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const hopPath = path.join(here, "../../payload/hop-handler.cjs");
const hop = require(hopPath) as {
  handleHopRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
};
const hardeningModule = path.join(here, "../../payload/injection-hardening.cjs");
const hardening = require(hardeningModule) as {
  HIDDEN_MARKER: string;
  REPLY_NUDGE_PROMPT: string;
  resetForTests: () => void;
  personOpenedPermission: (context: unknown, options?: { requireEpoch?: boolean }) => {
    eligible: boolean;
    identityGate: string;
    skipReason?: string;
    source: string;
    uncertain: boolean;
    botId?: string;
    conversationId?: string;
    epochId?: string;
  };
  stateKeyFrom: (permission: unknown) => string;
};
const runtimeModule = path.join(here, "../../payload/runtime.cjs");
const runtime = require(runtimeModule) as {
  deriveEpochId: (conversationId: string, messages: Array<Record<string, unknown>>) => string;
  conversationIdFromCtx: (ctx: unknown) => string;
};

const CONVERSATION_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

// ---------------------------------------------------------------------------
// The harness ContextImpl turn ctx (../packages/context/dist/core.js)
//
// The wrap (payload/runtime.cjs) has to read the conversation identity out of
// the frame chain the harness hands to `.stream(ctx, ...)`: `.with(key, value)`
// copies the direct parent's values, `.withName(name)` mints a frame with an
// EMPTY values Map, and the identity sits on an ancestor frame under a
// `createKey(Symbol("conversationId"), undefined)` key. Every other test in
// this file hand-writes the id into the body, which is exactly why an extractor
// that could not reach an ancestor frame passed CI.
// ---------------------------------------------------------------------------

type CtxFrame = {
  parent?: CtxFrame | undefined;
  values: Map<unknown, unknown>;
  name?: string;
  signal?: unknown;
};

const CONVERSATION_ID_SYMBOL = Symbol("conversationId");

function frameWith(parent: CtxFrame | undefined, key: unknown, value: unknown): CtxFrame {
  const values = new Map<unknown, unknown>(parent ? parent.values : []);
  values.set(key, value);
  return { parent: parent, values: values, name: "with" };
}

function frameNamed(parent: CtxFrame, name: string): CtxFrame {
  return { parent: parent, values: new Map<unknown, unknown>(), name: name };
}

/** Bootstrap frame with the identity, then >6 empty-values withName frames. */
function harnessTurnCtx(conversationId: string, resets = 10): CtxFrame {
  let frame = frameWith(undefined, CONVERSATION_ID_SYMBOL, conversationId);
  frame = frameWith(frame, "otel.span", { traceId: "turn" });
  for (let i = 0; i < resets; i++) frame = frameNamed(frame, "span-" + String(i));
  return frameWith(frame, "otel.span", { traceId: "stream" });
}

/** Non-silent first response: a current-response tool call never earns a second run. */
const NON_SILENT_REPLY = JSON.stringify({
  choices: [{
    message: {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "work-1", type: "function", function: { name: "Read", arguments: "{}" } }],
    },
    finish_reason: "tool_calls",
  }],
});

/** Silent stop with plain text: the shape L2/L3 act on. */
const SILENT_REPLY = JSON.stringify({
  choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
});

/** The exact DM transcript the custom wrap sends: host system + <user_query>. */
function wrapDmBody(overrides?: Record<string, unknown>) {
  const messages = [
    { role: "system", content: "Profile: /home/box/agent-data/agents/b8783b54-0ab5-42ec-ac3b-3c838bc528bd/profile.json" },
    { role: "user", content: "<user_query>please do the thing</user_query>" },
  ];
  return {
    model: "m",
    messages,
    stream: false,
    conversationId: CONVERSATION_ID,
    epochId: runtime.deriveEpochId(CONVERSATION_ID, [{ role: "user", content: "<user_query>please do the thing</user_query>" }]),
    ...overrides,
  };
}

interface UpstreamHit {
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

interface Harness {
  hopPort: number;
  dir: string;
  readonly hits: UpstreamHit[];
  /** Upstream document for the NEXT call (reset to non-silent after each read). */
  reply: string;
  post(body: Record<string, unknown>, extra?: { trusted?: Record<string, unknown> }): Promise<{ status: number; raw: string }>;
  close(): Promise<void>;
}

interface FixtureOptions {
  mode?: "off" | "enforce";
}

async function fixture(options: FixtureOptions = {}): Promise<Harness> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-conv-identity-"));
  const hits: UpstreamHit[] = [];
  const mode = options.mode ?? "enforce";
  writeFileSync(
    path.join(dir, "openbot-injection.json"),
    JSON.stringify({ mode, layers: { l1: { enabled: false }, l2: { enabled: true }, l3: { enabled: true } } }),
  );
  writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({ providers: { stub: "sk-test" } }));
  writeFileSync(path.join(dir, "openbot-logs.json"), JSON.stringify({ loggingEnabled: true, logBodies: true }));

  const managed: Array<[string, string | undefined]> = [
    ["OPENBOT_PLAN", process.env.OPENBOT_PLAN],
    ["OPENBOT_SECRETS", process.env.OPENBOT_SECRETS],
    ["OPENBOT_SAND_DATA", process.env.OPENBOT_SAND_DATA],
    ["OPENBOT_LOGS", process.env.OPENBOT_LOGS],
    ["OPENBOT_TURN_LEASE", process.env.OPENBOT_TURN_LEASE],
  ];
  const setEnv = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  setEnv("OPENBOT_PLAN", path.join(dir, "openbot-plan.json"));
  setEnv("OPENBOT_SECRETS", path.join(dir, "secrets.json"));
  setEnv("OPENBOT_SAND_DATA", dir);
  setEnv("OPENBOT_LOGS", path.join(dir, "openbot-logs.json"));
  setEnv("OPENBOT_TURN_LEASE", path.join(dir, "openbot-turn-lease.json"));

  let reply = NON_SILENT_REPLY;
  let upstreamPort = 0;
  const upstream = await new Promise<{ server: http.Server; port: number }>((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        hits.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>, headers: req.headers });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(reply);
        reply = NON_SILENT_REPLY;
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      upstreamPort = addr.port;
      resolve({ server, port: addr.port });
    });
  });
  writeFileSync(
    path.join(dir, "openbot-plan.json"),
    JSON.stringify({
      kind: "custom",
      catalog: {
        providers: [{ id: "stub", name: "Stub", origin: "http://127.0.0.1:" + String(upstreamPort) + "/v1", maxTokensDefault: 65536, mapFile: "provider-maps.cjs" }],
        models: [{ id: "stub:m", providerId: "stub", slug: "m", parameters: [] }],
        bindings: [],
      },
    }),
  );

  let trustedOnce: Record<string, unknown> | undefined;
  const hopServer = await new Promise<{ server: http.Server; port: number }>((resolve) => {
    const server = http.createServer((req, res) => {
      if (trustedOnce) {
        (req as unknown as Record<string, unknown>).openbotHostContext = trustedOnce;
        trustedOnce = undefined;
      }
      void hop.handleHopRequest(req, res).then((handled) => {
        if (!handled && !res.headersSent) {
          res.writeHead(404);
          res.end();
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve({ server, port: addr.port });
    });
  });

  const harness: Harness = {
    hopPort: hopServer.port,
    dir,
    hits,
    get reply() {
      return reply;
    },
    set reply(value: string) {
      reply = value;
    },
    post(body, extra) {
      trustedOnce = extra?.trusted;
      return new Promise((resolve) => {
        const payload = Buffer.from(JSON.stringify(body));
        const req = http.request(
          { host: "127.0.0.1", port: hopServer.port, path: "/v1/chat/completions", method: "POST", headers: { "Content-Type": "application/json", "Content-Length": String(payload.length) } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            const settle = () => resolve({ status: res.statusCode ?? 0, raw: Buffer.concat(chunks).toString("utf8") });
            res.on("end", settle);
            res.on("error", settle);
          },
        );
        req.on("error", () => {
          /* settle via response handlers */
        });
        req.end(payload);
      });
    },
    close: async () => {
      for (const [name, value] of managed) setEnv(name, value);
      await new Promise<void>((resolve) => hopServer.server.close(() => resolve()));
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

/** Parsed request-log rows from the fixture's sand-data dir. */
function readRows(dir: string): Array<Record<string, any>> {
  const file = path.join(dir, "openbot-requests.jsonl");
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows: Array<Record<string, any>> = [];
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* skip bad lines */
    }
  }
  return rows;
}

const MIRROR_FIELDS = ["conversationId", "conversation_id", "sessionId", "session_id", "chatId", "chat_id", "epochId", "epoch_id", "openbotConversationId", "openbotEpochId", "openbotBotId", "openbotChatType", "__openbot_api_type"];

function assertNoMirrorFields(body: Record<string, unknown>, label: string) {
  for (const key of MIRROR_FIELDS) {
    assert.equal(Object.prototype.hasOwnProperty.call(body, key), false, label + ": upstream body must not carry " + key);
  }
}

// ============================================================================
// The wrap-shaped request can actually fire the strategy.
// ============================================================================

test("custom wrap-shaped DM body under enforce: identity gate passes, stateKey set, L2 eligible", async () => {
  hardening.resetForTests();
  const env = await fixture({ mode: "enforce" });
  try {
    const out = await env.post(wrapDmBody());
    assert.equal(out.status, 200);
    assert.equal(env.hits.length, 1, "non-silent first response: no remediation run");
    await new Promise((resolve) => setTimeout(resolve, 150));
    const row = readRows(env.dir).find((r) => r.channel === "hop");
    assert.ok(row, "a hop row was recorded");
    assert.equal(row.injection.identityGateResult, "pass", "stamped identity lets the observable fallback pass");
    assert.equal(row.injection.l2Eligible, true, "the strategy can actually fire on the custom wrap path");
    // The skip reason classifies the RESPONSE (the stub answered with a tool
    // call, which is never remediated) -- it is NOT an identity skip like
    // no_bot_id / missing_conversation_id, which is the inert-before fix.
    assert.equal(row.injection.skipReason, "response_has_tool_calls");
    assert.equal(row.conversationId, CONVERSATION_ID, "hop log mirrors the wrap-stamped conversation id");
    assert.equal(row.botId, "b8783b54-0ab5-42ec-ac3b-3c838bc528bd", "botId still comes from the profile-path clue");
    // The gate verdict for exactly these observed values: observable fallback
    // lane, uncertain, and a non-empty strategy state key.
    const permission = hardening.personOpenedPermission({
      observed: {
        botId: row.botId,
        conversationId: row.conversationId,
        epochId: wrapDmBody().epochId,
        chatType: "dm",
        directChat: true,
      },
    }, { requireEpoch: true });
    assert.equal(permission.eligible, true);
    assert.equal(permission.source, "observable-fallback");
    assert.equal(permission.uncertain, true);
    assert.ok(hardening.stateKeyFrom(permission).length > 0, "non-empty strategy state key");
    // The upstream provider never sees the identity mirrors.
    assertNoMirrorFields(env.hits[0]!.body, "enforce wire");
    assert.equal(env.hits[0]!.body.model, "m");
  } finally {
    await env.close();
  }
});

test("OFF mode: wrap-stamped body stays a passthrough and carries no mirrors upstream", async () => {
  hardening.resetForTests();
  const off = await fixture({ mode: "off" });
  const offOut = await off.post(wrapDmBody());
  assert.equal(offOut.status, 200);
  assert.equal(off.hits.length, 1, "OFF never issues a second upstream call");
  const offRaw = offOut.raw;
  const offHit = off.hits[0]!.body;
  await off.close();

  hardening.resetForTests();
  const enforce = await fixture({ mode: "enforce" });
  try {
    const liveOut = await enforce.post(wrapDmBody());
    assert.equal(liveOut.status, 200);
    assert.equal(enforce.hits.length, 1);
    assert.equal(liveOut.raw, offRaw, "client bytes identical between OFF and a non-silent enforce turn");
    assertNoMirrorFields(enforce.hits[0]!.body, "enforce wire");
    // The OFF upstream body contains NONE of the mirror fields either.
    assertNoMirrorFields(offHit, "OFF wire");
  } finally {
    await enforce.close();
  }
});

test("group turn with wrap identity: still group_chat, not eligible, single upstream call", async () => {
  hardening.resetForTests();
  const env = await fixture({ mode: "enforce" });
  try {
    const body = wrapDmBody();
    body.messages = [
      { role: "system", content: "Profile: /home/box/agent-data/agents/b8783b54-0ab5-42ec-ac3b-3c838bc528bd/profile.json" },
      { role: "user", content: '<user_query>[Group chat: "ops"] please do the thing</user_query>' },
    ];
    body.epochId = runtime.deriveEpochId(CONVERSATION_ID, [{ role: "user", content: "group turn" }]);
    const out = await env.post(body);
    assert.equal(out.status, 200);
    assert.equal(env.hits.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const row = readRows(env.dir).find((r) => r.channel === "hop");
    assert.ok(row);
    assert.equal(row.injection.identityGateResult, "fail");
    assert.equal(row.injection.skipReason, "group_chat", "group turns stay ineligible even with full identity");
    assert.equal(row.injection.l2Eligible, false);
  } finally {
    await env.close();
  }
});

test("no conversation identity: honest missing_conversation_id, no mirror fields upstream", async () => {
  hardening.resetForTests();
  const env = await fixture({ mode: "enforce" });
  try {
    const body = wrapDmBody();
    delete (body as Record<string, unknown>).conversationId;
    const out = await env.post(body);
    assert.equal(out.status, 200);
    assert.equal(env.hits.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const row = readRows(env.dir).find((r) => r.channel === "hop");
    assert.ok(row);
    assert.equal(row.injection.identityGateResult, "fail");
    assert.equal(row.injection.skipReason, "missing_conversation_id", "the gate reports the honest reason");
    assertNoMirrorFields(env.hits[0]!.body, "identity-less wire");
  } finally {
    await env.close();
  }
});

test("same conversation + same latest user message derive the same epoch (L3 continuity precondition)", async () => {
  const messages = [{ role: "user", content: "<user_query>do the thing</user_query>" }];
  const again = [{ role: "user", content: "<user_query>do the thing</user_query>" }, { role: "assistant", content: "partial" }];
  const nextTurn = [{ role: "user", content: "<user_query>actually do it differently</user_query>" }];
  assert.equal(runtime.deriveEpochId(CONVERSATION_ID, messages), runtime.deriveEpochId(CONVERSATION_ID, again), "a follow-up request in the same turn keeps the epoch");
  assert.notEqual(runtime.deriveEpochId(CONVERSATION_ID, messages), runtime.deriveEpochId(CONVERSATION_ID, nextTurn), "a new user message starts a new epoch");
  assert.notEqual(runtime.deriveEpochId("other-conversation", messages), runtime.deriveEpochId(CONVERSATION_ID, messages), "epochs do not collide across conversations");
});

test("wrap-stamped identity arms L3: the next request of the turn is redriven BEFORE generation", async () => {
  hardening.resetForTests();
  const env = await fixture({ mode: "enforce" });
  try {
    // Request 1: touch-no-tool tail (the closing touch is the last assistant
    // tool_calls row) with a silent stop -- debt not owed, so L2 stays out,
    // but the strategy remembers the silent stop on the epoch state key.
    const touchTail = [
      { role: "system", content: "Profile: /home/box/agent-data/agents/b8783b54-0ab5-42ec-ac3b-3c838bc528bd/profile.json" },
      { role: "user", content: "<user_query>please do the thing</user_query>" },
      { role: "assistant", content: "", tool_calls: [{ id: "touch-1", type: "function", function: { name: "ReactToMessage", arguments: "{}" } }] },
    ];
    env.reply = SILENT_REPLY;
    const first = await env.post(wrapDmBody({ messages: touchTail }));
    assert.equal(first.status, 200);
    assert.equal(env.hits.length, 1, "request 1: silent but not owed -- no second run");
    // Request 2: same conversation, same latest user message => same epoch.
    // L3 is a PRE-GENERATION layer, so its nudge rides the FIRST upstream call
    // of this request. L2's remediation nudge is byte-identical for the
    // no-touch shape (HIDDEN_MARKER + REPLY_NUDGE_PROMPT), so the discriminator
    // is POSITION, never the nudge text: a call whose outgoing messages already
    // carry the nudge proves the next-request redrive, while a nudge that only
    // shows up on a later call of the same request would be L2's second run.
    const before = env.hits.length;
    env.reply = SILENT_REPLY;
    const second = await env.post(wrapDmBody());
    assert.equal(second.status, 200);
    assert.ok(env.hits.length > before, "request 2 reached the upstream");
    const firstCall = env.hits[before]!.body.messages as Array<{ role: string; content: string }>;
    assert.equal(
      firstCall[firstCall.length - 1]!.content,
      hardening.HIDDEN_MARKER + hardening.REPLY_NUDGE_PROMPT,
      "the L3 redrive is pre-generation: the nudge is already on request 2's FIRST upstream call",
    );
    assertNoMirrorFields(env.hits[before]!.body, "l3 redrive wire");
  } finally {
    await env.close();
  }
});

test("the harness ctx chain is the real identity source: deep-chain extraction arms the wrap path", async () => {
  hardening.resetForTests();
  const env = await fixture({ mode: "enforce" });
  try {
    // End to end over the REAL wrap extractor: the frame chain the harness
    // hands to `.stream(ctx, ...)` is the only production source of the
    // conversation id, and a >6-frame walk is what reaches it.
    const extracted = runtime.conversationIdFromCtx(harnessTurnCtx(CONVERSATION_ID, 12));
    assert.equal(extracted, CONVERSATION_ID, "the deep chain walk finds the bootstrap frame");
    const messages = [
      { role: "system", content: "Profile: /home/box/agent-data/agents/b8783b54-0ab5-42ec-ac3b-3c838bc528bd/profile.json" },
      { role: "user", content: "<user_query>please do the thing</user_query>" },
    ];
    const out = await env.post(wrapDmBody({
      messages,
      conversationId: extracted,
      epochId: runtime.deriveEpochId(extracted, messages),
    }));
    assert.equal(out.status, 200);
    assert.equal(env.hits.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const row = readRows(env.dir).find((r) => r.channel === "hop");
    assert.ok(row, "a hop row was recorded");
    assert.equal(row.injection.identityGateResult, "pass", "the chain-extracted id arms the observable fallback");
    assert.equal(row.injection.l2Eligible, true);
    assert.equal(row.botId, "b8783b54-0ab5-42ec-ac3b-3c838bc528bd");
    assert.equal(row.conversationId, CONVERSATION_ID);
    assertNoMirrorFields(env.hits[0]!.body, "chain-identity wire");
  } finally {
    await env.close();
  }
});

test("the trusted-context branch is untouched: trusted passes, body fields never promote", async () => {
  hardening.resetForTests();
  const env = await fixture({ mode: "enforce" });
  try {
    const trusted = {
      trusted: true,
      botId: "bot-1",
      conversationId: "conversation-1",
      epochId: "epoch-trusted-1",
      hidden: false,
      requestSource: "person",
      isSubagent: false,
      isSilenceAllowed: false,
      isRoutine: false,
      chatType: "dm",
      groupFlag: false,
      isGroupMemberTurn: false,
    };
    // Minimal body WITHOUT wrap-stamped fields: the trusted context alone
    // must still gate pass.
    const out = await env.post({ model: "m", messages: [{ role: "user", content: "hi" }], stream: false }, { trusted });
    assert.equal(out.status, 200);
    assert.equal(env.hits.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const row = readRows(env.dir).find((r) => r.channel === "hop");
    assert.ok(row);
    assert.equal(row.injection.identityGateResult, "pass", "trusted person turn still passes");
    assert.equal(row.injection.l2Eligible, true);
    // Body-stamped identity must never PROMOTE a request to trusted: bare
    // body fields land on the uncertain observable lane, never the
    // authenticated one.
    const observedOnly = hardening.personOpenedPermission({
      observed: { botId: "b", conversationId: "c", epochId: "e", chatType: "dm", directChat: true },
    });
    assert.equal(observedOnly.source, "observable-fallback");
    assert.equal(observedOnly.uncertain, true);
    // The hop builds exactly this shape from a wrap-stamped body (no trusted
    // request context, no host-shape markers): observed values land in
    // context.observed, so the gate takes the observable lane even though
    // every field is present at the top level of the observed bag.
    // The hop builds exactly this shape from a wrap-stamped body: observed
    // values ride context.observed, so the gate takes the uncertain
    // observable lane even though every identity field is present. Body
    // fields can never reach the trusted gate because trust comes only from
    // req.openbotHostContext / req.hostContext (contextFromRequest).
    const bareBodyShape = hardening.personOpenedPermission({
      observed: { botId: "b", conversationId: "c", epochId: "e", chatType: "dm", directChat: true },
    }, { requireEpoch: true });
    assert.equal(bareBodyShape.source, "observable-fallback", "body fields can never reach the trusted gate");
    assert.equal(bareBodyShape.uncertain, true);
    assert.equal(bareBodyShape.eligible, true, "full observed identity gates pass on the fallback lane");
  } finally {
    await env.close();
  }
});
