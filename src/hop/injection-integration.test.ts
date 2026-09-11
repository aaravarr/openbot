import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Adversarial integration tests for the delivery-follow-up ("injection
 * hardening") strategy. Unlike src/hop/injection-hardening.test.ts, which
 * drives the strategy API directly, every case here starts a real loopback
 * HTTP hop (payload/hop-handler.cjs handleHopRequest), points it at a stub
 * upstream on 127.0.0.1, and asserts only what a client can observe:
 * upstream call count, the exact bytes the client received, and that no
 * SendToUser / SendMessage / ReactToMessage tool call is ever forged.
 */

const require = createRequire(import.meta.url);
const hopPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../payload/hop-handler.cjs");
const hop = require(hopPath) as {
  handleHopRequest: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>;
};
const hardeningModule = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../payload/injection-hardening.cjs",
);
const hardening = require(hardeningModule) as {
  HIDDEN_MARKER: string;
  REPLY_NUDGE_PROMPT: string;
  CLOSING_SEND_PROMPT: string;
  resetForTests: () => void;
};
const convertersModule = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../payload/protocol-converters.cjs",
);
const protocolConverters = require(convertersModule) as {
  anthropicSseToChat: (raw: string, opts?: { terminal?: boolean; framing?: boolean }) => string;
};

type Protocol = "chat-completions" | "responses" | "anthropic";

/** Trusted person-opened host context attached to the inbound request. */
function personContext(epochId: string) {
  return {
    trusted: true,
    botId: "bot-1",
    conversationId: "conversation-1",
    epochId,
    hidden: false,
    requestSource: "person",
    isSubagent: false,
    isSilenceAllowed: false,
    isRoutine: false,
    chatType: "dm",
    groupFlag: false,
    isGroupMemberTurn: false,
  };
}

/** The exact suffix the nudge user turn must carry for a debt shape. */
function nudgeContent(shape: "no-touch" | "touch-then-tool"): string {
  return shape === "no-touch"
    ? hardening.HIDDEN_MARKER + hardening.REPLY_NUDGE_PROMPT
    : hardening.HIDDEN_MARKER + hardening.CLOSING_SEND_PROMPT;
}

/** Chat-completions transcript whose latest-user tail selects a debt shape. */
function transcript(shape: "no-touch" | "touch-then-tool" | "touch-no-tool", question: string) {
  if (shape === "no-touch") return [{ role: "user", content: question }];
  if (shape === "touch-no-tool") {
    // The classifier counts the paired role=tool row as chronology, so a
    // not-owed tail is expressed the way the host emits it in the incident
    // family: the closing touch is the LAST assistant tool_calls row with no
    // later tool result following it.
    return [
      { role: "user", content: question },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "touch-1", type: "function", function: { name: "ReactToMessage", arguments: "{}" } }],
      },
    ];
  }
  return [
    { role: "user", content: question },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "touch-2", type: "function", function: { name: "SendToUser", arguments: "{\"type\":\"text\"}" } }],
    },
    { role: "tool", tool_call_id: "touch-2", content: "ack" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "work-1", type: "function", function: { name: "Read", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "work-1", content: "file contents" },
  ];
}
// ---- Upstream payload shapes per protocol. The hop always sends the chat
// ---- body through chatToResponses / chatToAnthropic for the converted
// ---- families, so the stub answers in that family's native shape and lets
// ---- the hop convert the response back to the host chat shape.

interface UpstreamHit {
  body: Record<string, unknown>;
  headers: http.IncomingHttpHeaders;
}

interface PlanItem {
  status?: number;
  error?: Record<string, unknown>;
  /** Deltas for the first upstream call (or the only call of this item). */
  text?: string[];
  /**
   * Deltas for the second upstream call when one PlanItem serves both calls
   * of a remediation turn. The splice contract (plan §7.2) forwards the
   * second run's deltas on the same host stream, so the two calls MUST emit
   * distinguishable text or the client bytes cannot tell the runs apart.
   */
  text2?: string[];
  toolCall?: { name: string; id: string; args?: string };
  /** Terminal finish this item's own response carries (default: tool_calls with a toolCall, else stop). */
  finish?: string;
  /** Emit everything except the terminal + [DONE], then wait. */
  hang?: boolean;
}

/** View of a PlanItem for one specific upstream call (first vs second). */
function itemForCall(item: PlanItem, secondCall: boolean): PlanItem {
  if (!secondCall) return item;
  // A single-item plan carries the second call's text in text2; a
  // two-item plan already wrote the second call's text in item[1].text.
  return {
    ...(item.status !== undefined ? { status: item.status } : {}),
    ...(item.error !== undefined ? { error: item.error } : {}),
    text: item.text2 !== undefined ? item.text2 : (item.text ?? []),
    ...(item.toolCall !== undefined ? { toolCall: item.toolCall } : {}),
    ...(item.finish !== undefined ? { finish: item.finish } : {}),
    ...(item.hang !== undefined ? { hang: item.hang } : {}),
  };
}

function upstreamJson(protocol: Protocol, item: PlanItem): string {
  const text = (item.text ?? []).join("");
  const finish = item.finish ?? (item.toolCall ? "tool_calls" : "stop");
  if (protocol === "responses") {
    return JSON.stringify({
      id: "resp_1",
      status: "completed",
      model: "m",
      output: [
        ...(text ? [{ type: "message", content: [{ type: "output_text", text }] }] : []),
        ...(item.toolCall
          ? [{ type: "function_call", call_id: item.toolCall.id, name: item.toolCall.name, arguments: item.toolCall.args ?? "{}" }]
          : []),
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }
  if (protocol === "anthropic") {
    return JSON.stringify({
      id: "msg_1",
      model: "m",
      stop_reason: finish === "tool_calls" ? "tool_use" : "end_turn",
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...(item.toolCall ? [{ type: "tool_use", id: item.toolCall.id, name: item.toolCall.name, input: JSON.parse(item.toolCall.args ?? "{}") }] : []),
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  }
  return JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: text || null,
        ...(item.toolCall
          ? { tool_calls: [{ id: item.toolCall.id, type: "function", function: { name: item.toolCall.name, arguments: item.toolCall.args ?? "{}" } }] }
          : {}),
      },
      finish_reason: finish,
    }],
  });
}

function upstreamSse(protocol: Protocol, item: PlanItem): string {
  const finish = item.finish ?? (item.toolCall ? "tool_calls" : "stop");
  const frames: string[] = [];
  if (protocol === "responses") {
    // responsesSseToChat: response.created -> { role: "assistant" } chunk.
    frames.push(sseData({ type: "response.created", response: { id: "resp_sse", model: "m" } }));
    const pieces = item.text ?? [];
    for (let i = 0; i < pieces.length; i++) {
      // First text delta carries the assistant role, mirroring the converter's
      // deltaWithRole behaviour at the hop boundary.
      frames.push(sseData({ type: "response.output_text.delta", delta: pieces[i] }));
    }
    if (item.toolCall) {
      frames.push(sseData({
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "function_call", call_id: item.toolCall.id, name: item.toolCall.name },
      }));
      frames.push(sseData({
        type: "response.function_call_arguments.delta",
        output_index: 0,
        delta: item.toolCall.args ?? "{}",
      }));
    }
    frames.push(sseData({
      type: "response.completed",
      response: { id: "resp_sse", model: "m", status: "completed", usage: { input_tokens: 1, output_tokens: 1 } },
    }));
  } else if (protocol === "anthropic") {
    // anthropicSseToChat: message_start carries no chunk; the first text delta
    // must arrive as { role, content } exactly like a hop-emitted first chunk.
    const pieces = item.text ?? [];
    for (let i = 0; i < pieces.length; i++) {
      frames.push(sseData({ type: "content_block_delta", delta: { type: "text_delta", text: pieces[i] } }));
    }
    if (item.toolCall) {
      frames.push(sseData({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: item.toolCall.id, name: item.toolCall.name } }));
      frames.push(sseData({ type: "content_block_delta", delta: { type: "input_json_delta", index: 1, partial_json: item.toolCall.args ?? "{}" } }));
    }
    frames.push(sseData({ type: "message_delta", delta: { stop_reason: finish === "tool_calls" ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } }));
  } else {
    frames.push(sseData({ choices: [{ delta: { role: "assistant" }, finish_reason: null }] }));
    for (const piece of item.text ?? []) {
      frames.push(sseData({ choices: [{ delta: { content: piece }, finish_reason: null }] }));
    }
    if (item.toolCall) {
      frames.push(sseData({
        choices: [{ delta: { tool_calls: [{ index: 0, id: item.toolCall.id, type: "function", function: { name: item.toolCall.name, arguments: item.toolCall.args ?? "{}" } }] }, finish_reason: null }],
      }));
    }
    frames.push(sseData({ choices: [{ delta: {}, finish_reason: finish }] }));
  }
  frames.push("data: [DONE]\n\n");
  return frames.join("");
}

function sseData(value: unknown): string {
  return "data: " + JSON.stringify(value) + "\n\n";
}

interface Harness {
  hopPort: number;
  readonly hits: UpstreamHit[];
  plan: PlanItem[];
  /** Completes an in-flight hang item (terminal + [DONE] then end). */
  releaseHang: (() => void) | undefined;
  /** Destroys an in-flight hang item without a terminal (upstream drop). */
  dropUpstream: (() => void) | undefined;
  /** Push a client request through the real hop handler on loopback. */
  post: (body: Record<string, unknown>, extra?: { epochId?: string; hangUpAfterFirstByte?: boolean }) => Promise<{
    status: number;
    raw: string;
    ctype: string;
    headers: http.IncomingHttpHeaders;
  }>;
  close: () => Promise<void>;
}

interface FixtureOptions {
  protocol: Protocol;
  /** Injection file mode; "off" proves the pre-feature behaviour. */
  mode?: "off" | "dry-run" | "enforce";
  /** Extra layer flags; defaults keep l2 on and l1/l3 off for focus. */
  layers?: { l1?: boolean; l2?: boolean; l3?: boolean };
  /** Override l2 knobs (watchdog, retry budget). */
  l2?: Record<string, unknown>;
}

async function fixture(options: FixtureOptions): Promise<Harness> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-injection-int-"));
  const hits: UpstreamHit[] = [];
  let plan: PlanItem[] = [];
  let releaseHang: (() => void) | undefined;
  let dropUpstream: (() => void) | undefined;
  let extraEpochId: string | undefined;

  // Chat-completions streams carry a role-only first chunk that is part of
  // the upstream document; assertCleanStream must not count it as content.
  const stripRoleChunk = options.protocol !== "chat-completions" ? false : true;

  const upstream = await new Promise<{ server: http.Server; port: number }>((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        hits.push({ body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>, headers: req.headers });
        // Distinguish the first upstream call from a remediation second call
      // so both runs can carry their own text/finish (see itemForCall).
      const item = itemForCall(plan[Math.min(hits.length - 1, plan.length - 1)] ?? {}, hits.length > 1);
        if (item.status !== undefined) {
          res.writeHead(item.status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(item.error ?? { error: { message: "upstream boom" } }));
          return;
        }
        // The hop negotiates by its own Accept header; stream:false requests
        // are buffered, so answer with the family's native JSON document.
        const wantsStream = (hits[hits.length - 1]?.body as { stream?: boolean } | undefined)?.stream === true;
        if (!wantsStream) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(upstreamJson(options.protocol, item));
          return;
        }
        const sse = upstreamSse(options.protocol, item);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        // Everything before the final terminal+[DONE] frame goes out at once;
        // the last frame carries the finish event and the [DONE] terminator.
        const doneIndex = sse.lastIndexOf("data: [DONE]");
        const head = sse.slice(0, doneIndex);
        const tail = sse.slice(doneIndex);
        res.write(head);
        if (item.hang) {
          releaseHang = () => {
            res.write(tail);
            res.end();
          };
          dropUpstream = () => {
            res.destroy();
          };
          return;
        }
        res.write(tail);
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no port");
      resolve({ server, port: addr.port });
    });
  });

  const mode = options.mode ?? "off";
  const layerBlocks = {
    l1: { enabled: options.layers?.l1 === true },
    l2: { enabled: options.layers?.l2 !== false, ...(options.l2 ?? {}) },
    l3: { enabled: options.layers?.l3 === true },
  };
  writeFileSync(path.join(dir, "openbot-injection.json"), JSON.stringify({ mode, layers: layerBlocks }));
  writeFileSync(
    path.join(dir, "openbot-plan.json"),
    JSON.stringify({
      kind: "custom",
      catalog: {
        providers: [
          {
            id: "stub",
            name: "Stub",
            origin: "http://127.0.0.1:" + String(upstream.port) + "/v1",
            maxTokensDefault: 65536,
            mapFile: "provider-maps.cjs",
            ...(options.protocol === "chat-completions" ? {} : { apiType: options.protocol }),
          },
        ],
        models: [{ id: "stub:m", providerId: "stub", slug: "m", parameters: [] }],
        bindings: [],
      },
    }),
  );
  writeFileSync(path.join(dir, "secrets.json"), JSON.stringify({ providers: { stub: "sk-test" } }));
  writeFileSync(path.join(dir, "openbot-logs.json"), JSON.stringify({ loggingEnabled: false }));

  const managed: Array<[string, string | undefined]> = [
    ["OPENBOT_PLAN", process.env.OPENBOT_PLAN],
    ["OPENBOT_SECRETS", process.env.OPENBOT_SECRETS],
    ["OPENBOT_SAND_DATA", process.env.OPENBOT_SAND_DATA],
    ["OPENBOT_LOGS", process.env.OPENBOT_LOGS],
    ["OPENBOT_INJECTION_MODE", process.env.OPENBOT_INJECTION_MODE],
    ["OPENBOT_INJECTION_L1_ENABLED", process.env.OPENBOT_INJECTION_L1_ENABLED],
    ["OPENBOT_INJECTION_L2_ENABLED", process.env.OPENBOT_INJECTION_L2_ENABLED],
    ["OPENBOT_INJECTION_L3_ENABLED", process.env.OPENBOT_INJECTION_L3_ENABLED],
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
  setEnv("OPENBOT_INJECTION_MODE", undefined);
  setEnv("OPENBOT_INJECTION_L1_ENABLED", undefined);
  setEnv("OPENBOT_INJECTION_L2_ENABLED", undefined);
  setEnv("OPENBOT_INJECTION_L3_ENABLED", undefined);
  setEnv("OPENBOT_TURN_LEASE", path.join(dir, "openbot-turn-lease.json"));

  const hopServer = await new Promise<{ server: http.Server; port: number }>((resolve) => {
    const server = http.createServer((req, res) => {
      // Attach the trusted host context the way an in-process host does, on
      // the request object itself, keyed by this request's epoch.
      (req as unknown as Record<string, unknown>).openbotHostContext = hostContext(extraEpochId ?? "");
      extraEpochId = undefined;
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
    hits,
    get plan() {
      return plan;
    },
    set plan(value: PlanItem[]) {
      plan = value;
    },
    get releaseHang() {
      return releaseHang;
    },
    get dropUpstream() {
      return dropUpstream;
    },
    post(body, extra) {
      extraEpochId = extra?.epochId;
      return new Promise((resolve) => {
        const payload = Buffer.from(JSON.stringify(body));
        const req = http.request(
          {
            host: "127.0.0.1",
            port: hopServer.port,
            path: "/v1/chat/completions",
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(payload.length),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            let hungUp = false;
            res.on("data", (chunk: Buffer) => {
              if (!hungUp && extra?.hangUpAfterFirstByte) {
                hungUp = true;
                req.destroy();
              }
              chunks.push(chunk);
            });
            let settled = false;
            const settle = () => {
              if (settled) return;
              settled = true;
              resolve({
                status: res.statusCode ?? 0,
                raw: Buffer.concat(chunks).toString("utf8"),
                ctype: String(res.headers["content-type"] || ""),
                headers: res.headers,
              });
            };
            res.on("end", settle);
            res.on("close", settle);
            res.on("error", settle);
          },
        );
        req.on("error", () => {
          /* the deliberate hang-up case destroys the request */
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

/** The inbound request body the test client sends. */
function inboundBody(shape: "no-touch" | "touch-then-tool" | "touch-no-tool", stream: boolean) {
  return {
    model: "m",
    conversationId: "conversation-1",
    messages: transcript(shape, "please do the thing"),
    stream,
  };
}

/** Client-visible SSE transcript, parsed defensively. */
function parseSseText(raw: string): { dataLines: string[]; done: boolean } {
  const dataLines: string[] = [];
  let done = false;
  let roleChunkSeen = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5).trim();
    if (value === "[DONE]") {
      done = true;
      continue;
    }
    // The role-only chunk is the wire head of a chat-completions document;
    // the client-visible contract is the content deltas, terminal and [DONE].
    if (!roleChunkSeen && value.includes('"delta":{"role":"assistant"}')) {
      roleChunkSeen = true;
      continue;
    }
    dataLines.push(value);
  }
  return { dataLines, done };
}

interface ChunkView {
  content: string | null;
  finish: string | null;
  toolNames: string[];
}

function chunkView(dataLine: string): ChunkView {
  const parsed = JSON.parse(dataLine) as {
    choices?: Array<{
      delta?: { content?: string; tool_calls?: Array<{ function?: { name?: string } }> };
      finish_reason?: string | null;
    }>;
  };
  const choice = parsed.choices?.[0] ?? {};
  const delta = choice.delta ?? {};
  return {
    content: typeof delta.content === "string" ? delta.content : null,
    finish: choice.finish_reason ?? null,
    toolNames: (delta.tool_calls ?? []).map((call) => call.function?.name ?? "").filter(Boolean),
  };
}

function isDeliveryName(name: string): boolean {
  return name === "SendToUser" || name === "SendMessage" || name === "ReactToMessage";
}

/** Assert the core stream invariants: deltas once and in order, one terminal, [DONE], no forgery.
 * firstDeltas lists EVERY content delta the client must have received, in
 * exact order — including a remediation second run's deltas, which the spec
 * (§7.2) splices onto the same host stream before its terminal.
 *
 * Per-frame conversion never synthesizes terminals or [DONE] framing (plan
 * §7.3): exactly one finish-bearing chunk and one [DONE] are expected, always. */
function assertCleanStream(raw: string, opts: { firstDeltas: string[]; terminalFinish: string; allowDeliveryTools?: number }): ChunkView[] {
  const parsed = parseSseText(raw);
  assert.equal(parsed.done, true, "client stream must end with [DONE]");
  const views = parsed.dataLines.map(chunkView);
  const contents = views.map((view) => view.content).filter((value): value is string => value !== null);
  assert.deepEqual(contents, opts.firstDeltas, "every original delta present exactly once, in order");
  const finishes = views.map((view) => view.finish).filter((value): value is string => value !== null);
  assert.deepEqual(finishes, [opts.terminalFinish], "exactly one terminal finish event");
  const delivery = views.flatMap((view) => view.toolNames).filter(isDeliveryName);
  assert.equal(delivery.length, opts.allowDeliveryTools ?? 0, "no forged delivery tool call");
  return views;
}

/** Inspect a buffered host JSON response. */
function viewJson(raw: string): { content: string | null; finish: string | null; toolNames: string[] } {
  const parsed = JSON.parse(raw) as {
    choices?: Array<{
      message?: { content?: string | null; tool_calls?: Array<{ function?: { name?: string } }> };
      finish_reason?: string | null;
    }>;
  };
  const choice = parsed.choices?.[0] ?? {};
  const message = choice.message ?? {};
  return {
    content: typeof message.content === "string" ? message.content : null,
    finish: choice.finish_reason ?? null,
    toolNames: (message.tool_calls ?? []).map((call) => call.function?.name ?? "").filter(Boolean),
  };
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timeout waiting for " + label);
}

function hostContext(epochId: string) {
  // The trusted host contract is the in-process request object: the hop's
  // contextFromRequest reads req.openbotHostContext directly, which is how an
  // in-process host (the wrapped Grok host calls the handler as a library)
  // supplies authenticated identity. Transport headers are only the narrow
  // observable fallback and can never reach the trusted gate.
  return personContext(epochId);
}

// ============================================================================
// Protocol x debt-shape matrix. A failure names protocol, encoding and shape.
// ============================================================================

test("chat-completions SSE no-touch: terminal-only hold, exactly one 3.27 nudge with the exact suffix", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "chat-completions", mode: "enforce" });
  // The nudge run (second call) answers with its own text: the spec splices
  // it onto the same host stream (§7.2), so identical stub bodies for both
  // calls would make the first run indistinguishable from the second.
  env.plan = [{ text: ["Hel", "lo wo", "rld"], text2: ["nudge", " reply"] }];
  try {
    const out = await env.post(inboundBody("no-touch", true), { epochId: "epoch-cc-nt-sse" });
    assert.equal(out.status, 200);
    assert.match(out.ctype, /text\/event-stream/);
    assert.equal(env.hits.length, 2, "one first run plus exactly one nudge run");
    const secondMessages = env.hits[1]?.body.messages as Array<{ role: string; content: string }>;
    const last = secondMessages?.[secondMessages.length - 1];
    assert.equal(last?.role, "user");
    assert.equal(last?.content, nudgeContent("no-touch"), "[SAND_HIDDEN_PROMPT] + exact official 3.27 body");
    assert.equal(
      JSON.stringify(secondMessages.slice(0, -1)),
      JSON.stringify(env.hits[0]?.body.messages),
      "nudge reuses the canonical first-run context without mutation",
    );
    assertCleanStream(out.raw, { firstDeltas: ["Hel", "lo wo", "rld", "nudge", " reply"], terminalFinish: "stop" });
    assert.equal(out.raw.includes("[SAND_HIDDEN_PROMPT]"), false, "the nudge suffix never leaks to the client");
  } finally {
    await env.close();
  }
});

test("chat-completions SSE touch-then-tool: one 3.28 closing-send run, second real SendToUser streamed once", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "chat-completions", mode: "enforce" });
  env.plan = [
    { text: ["part one"] },
    { toolCall: { name: "SendToUser", id: "second-real", args: "{\"type\":\"text\",\"text\":\"here\"}" } },
  ];
  try {
    const out = await env.post(inboundBody("touch-then-tool", true), { epochId: "epoch-cc-ttt-sse" });
    assert.equal(out.status, 200);
    assert.equal(env.hits.length, 2);
    const secondMessages = env.hits[1]?.body.messages as Array<{ role: string; content: string }>;
    assert.equal(secondMessages?.[secondMessages.length - 1]?.content, nudgeContent("touch-then-tool"));
    // The second run streams its real SendToUser and closes the single host
    // stream with ITS OWN terminal: finish=tool_calls (plan §7.2 "finally the
    // second run's terminal event"; §7.5 "forwarded as real model output").
    const views = assertCleanStream(out.raw, { firstDeltas: ["part one"], terminalFinish: "tool_calls", allowDeliveryTools: 1 });
    const touches = views.filter((view) => view.toolNames.includes("SendToUser"));
    assert.equal(touches.length, 1, "the second-run SendToUser arrives exactly once");
    assert.equal(views[views.length - 1]?.finish, "tool_calls", "only the second terminal closes the single stream");
  } finally {
    await env.close();
  }
});

test("chat-completions SSE touch-no-tool: not owed -- one upstream call, byte-clean untouched stream", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "chat-completions", mode: "enforce" });
  env.plan = [{ text: ["straight answer"] }];
  try {
    const out = await env.post(inboundBody("touch-no-tool", true), { epochId: "epoch-cc-tnt-sse" });
    assert.equal(out.status, 200);
    assert.equal(env.hits.length, 1, "no second request for a not-owed tail");
    assertCleanStream(out.raw, { firstDeltas: ["straight answer"], terminalFinish: "stop" });
    assert.equal(out.raw.includes("[SAND_HIDDEN_PROMPT]"), false);
  } finally {
    await env.close();
  }
});

test("chat-completions JSON no-touch: one 3.27 run and one legal merged host response", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "chat-completions", mode: "enforce" });
  env.plan = [
    { text: ["first answer"] },
    { toolCall: { name: "SendToUser", id: "json-second", args: "{\"type\":\"text\"}" } },
  ];
  try {
    const out = await env.post(inboundBody("no-touch", false), { epochId: "epoch-cc-nt-json" });
    assert.equal(out.status, 200);
    assert.match(out.ctype, /application\/json/);
    assert.equal(env.hits.length, 2);
    const secondMessages = env.hits[1]?.body.messages as Array<{ role: string; content: string }>;
    assert.equal(secondMessages?.[secondMessages.length - 1]?.content, nudgeContent("no-touch"));
    const view = viewJson(out.raw);
    assert.equal(view.content, "first answer", "first-run text survives the merge");
    assert.deepEqual(view.toolNames, ["SendToUser"], "the real second-run tool call, nothing forged");
    // The merged document keeps the SECOND run's terminal (its own real
    // tool-call finish), per plan §7.2 §7.5 -- never rewritten to stop.
    assert.equal(view.finish, "tool_calls");
    assert.equal((out.raw.match(/"finish_reason"/g) ?? []).length, 1, "one legal document, one finish_reason");
  } finally {
    await env.close();
  }
});

test("responses SSE no-touch: the nudge run reuses the Responses request adapter with the exact suffix", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "responses", mode: "enforce" });
  env.plan = [{ text: ["Resp", "onse text"], text2: ["nudge text"] }];
  try {
    const out = await env.post(inboundBody("no-touch", true), { epochId: "epoch-resp-nt-sse" });
    assert.equal(out.status, 200);
    assert.match(out.ctype, /text\/event-stream/);
    assert.equal(env.hits.length, 2);
    const secondInput = env.hits[1]?.body.input as Array<Record<string, unknown>>;
    const last = secondInput?.[secondInput.length - 1];
    assert.equal(last?.role, "user");
    assert.equal(
      JSON.stringify(last),
      JSON.stringify({ role: "user", content: nudgeContent("no-touch") }),
      "the suffix maps through chatToResponses as a plain user turn",
    );
    assertCleanStream(out.raw, { firstDeltas: ["Resp", "onse text", "nudge text"], terminalFinish: "stop" });
    assert.equal(out.raw.includes("[SAND_HIDDEN_PROMPT]"), false);
  } finally {
    await env.close();
  }
});

test("responses JSON touch-then-tool: 3.28 selected, merged response keeps one terminal and the real tool call", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "responses", mode: "enforce" });
  env.plan = [
    { text: ["worked answer"] },
    { toolCall: { name: "SendToUser", id: "resp-second", args: "{\"type\":\"text\"}" } },
  ];
  try {
    const out = await env.post(inboundBody("touch-then-tool", false), { epochId: "epoch-resp-ttt-json" });
    assert.equal(out.status, 200);
    assert.equal(env.hits.length, 2);
    const secondInput = env.hits[1]?.body.input as Array<Record<string, unknown>>;
    assert.equal((secondInput?.[secondInput.length - 1])?.content, nudgeContent("touch-then-tool"));
    const view = viewJson(out.raw);
    assert.equal(view.content, "worked answer");
    assert.deepEqual(view.toolNames, ["SendToUser"]);
    // Merged document carries the second run's own tool_calls terminal (§7.2/§7.5).
    assert.equal(view.finish, "tool_calls");
  } finally {
    await env.close();
  }
});

test("responses JSON touch-no-tool: not owed -- exactly one upstream call, immediate release", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "responses", mode: "enforce" });
  env.plan = [{ text: ["complete"] }];
  try {
    const out = await env.post(inboundBody("touch-no-tool", false), { epochId: "epoch-resp-tnt-json" });
    assert.equal(out.status, 200);
    assert.equal(env.hits.length, 1);
    const view = viewJson(out.raw);
    assert.equal(view.content, "complete");
    assert.equal(view.finish, "stop");
    assert.deepEqual(view.toolNames, []);
  } finally {
    await env.close();
  }
});

test("anthropic SSE no-touch: 3.27 suffix mapped through chatToAnthropic, history prefix untouched", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "anthropic", mode: "enforce" });
  env.plan = [{ text: ["Anth", "ropic text"], text2: ["nudge text"] }];
  try {
    const out = await env.post(inboundBody("no-touch", true), { epochId: "epoch-anth-nt-sse" });
    assert.equal(out.status, 200);
    assert.match(out.ctype, /text\/event-stream/);
    assert.equal(env.hits.length, 2);
    const secondMessages = env.hits[1]?.body.messages as Array<{ role: string; content: unknown }>;
    const last = secondMessages?.[secondMessages.length - 1];
    assert.equal(last?.role, "user");
    assert.equal(last?.content, nudgeContent("no-touch"));
    assert.equal(env.hits[1]?.body.system, env.hits[0]?.body.system, "history prefix is not mutated");
    assertCleanStream(out.raw, { firstDeltas: ["Anth", "ropic text", "nudge text"], terminalFinish: "stop" });
    assert.equal(out.raw.includes("[SAND_HIDDEN_PROMPT]"), false);
  } finally {
    await env.close();
  }
});

test("anthropic JSON touch-then-tool: 3.28 selected with one legal merged host response", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "anthropic", mode: "enforce" });
  env.plan = [
    { text: ["still waiting"] },
    { toolCall: { name: "SendToUser", id: "anth-second", args: "{\"type\":\"text\"}" } },
  ];
  try {
    const out = await env.post(inboundBody("touch-then-tool", false), { epochId: "epoch-anth-ttt-json" });
    assert.equal(out.status, 200);
    assert.equal(env.hits.length, 2);
    const secondMessages = env.hits[1]?.body.messages as Array<{ role: string; content: unknown }>;
    assert.equal(secondMessages?.[secondMessages.length - 1]?.content, nudgeContent("touch-then-tool"));
    const view = viewJson(out.raw);
    assert.equal(view.content, "still waiting");
    assert.deepEqual(view.toolNames, ["SendToUser"]);
    // Merged document carries the second run's own tool_calls terminal (§7.2/§7.5).
    assert.equal(view.finish, "tool_calls");
  } finally {
    await env.close();
  }
});

test("anthropic SSE touch-no-tool: released immediately with zero second calls", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "anthropic", mode: "enforce" });
  env.plan = [{ text: ["done already"] }];
  try {
    const out = await env.post(inboundBody("touch-no-tool", true), { epochId: "epoch-anth-tnt-sse" });
    assert.equal(out.status, 200);
    assert.equal(env.hits.length, 1);
    assertCleanStream(out.raw, { firstDeltas: ["done already"], terminalFinish: "stop" });
  } finally {
    await env.close();
  }
});

// ---- Non-silent first responses: any current-response tool call and any
// ---- terminal tool-call finish must never trigger remediation.

test("responses JSON current-response tool call: immediate release, zero second calls, real tool preserved", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "responses", mode: "enforce" });
  env.plan = [{ text: [], toolCall: { name: "Read", id: "current-read", args: "{}" } }];
  try {
    const out = await env.post(inboundBody("no-touch", false), { epochId: "epoch-resp-tool" });
    assert.equal(out.status, 200);
    assert.equal(env.hits.length, 1, "tool-bearing responses are non-silent");
    const view = viewJson(out.raw);
    assert.deepEqual(view.toolNames, ["Read"]);
    assert.equal(view.finish, "tool_calls");
  } finally {
    await env.close();
  }
});

test("chat-completions SSE delivery call in current response: finish tool_calls, no second run", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "chat-completions", mode: "enforce" });
  env.plan = [{ text: ["sending now"], toolCall: { name: "SendToUser", id: "current-touch", args: "{\"type\":\"text\"}" } }];
  try {
    const out = await env.post(inboundBody("no-touch", true), { epochId: "epoch-cc-tool" });
    assert.equal(out.status, 200);
    assert.equal(env.hits.length, 1);
    const views = assertCleanStream(out.raw, {
      firstDeltas: ["sending now"],
      terminalFinish: "tool_calls",
      allowDeliveryTools: 1,
    });
    assert.equal(views.filter((view) => view.toolNames.includes("SendToUser")).length, 1, "the real touch survives");
  } finally {
    await env.close();
  }
});

// ---- OFF mode: byte-identical pre-feature behaviour.

test("OFF chat-completions SSE: bytes are exactly the classic passthrough frames and equal the not-owed release", async () => {
  hardening.resetForTests();
  const off = await fixture({ protocol: "chat-completions", mode: "off" });
  off.plan = [{ text: ["Hel", "lo"] }];
  const offOut = await off.post(inboundBody("no-touch", true), { epochId: "epoch-off-sse" });
  assert.equal(off.hits.length, 1, "OFF never issues a second upstream call");
  await off.close();

  hardening.resetForTests();
  const live = await fixture({ protocol: "chat-completions", mode: "enforce" });
  live.plan = [{ text: ["Hel", "lo"] }];
  const liveOut = await live.post(inboundBody("touch-no-tool", true), { epochId: "epoch-live-sse" });
  assert.equal(live.hits.length, 1);
  await live.close();

  assert.equal(liveOut.raw, offOut.raw, "not-owed release must be byte-identical to OFF");
  // OFF is a byte passthrough: the client receives exactly the stub's chat
  // document, including the stub's role-only head chunk (the stub frames are
  // asserted in full below; no id/object/model decoration is ever added).
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    "data: " + JSON.stringify({ choices: [{ delta, finish_reason: finish }] }) + "\n\n";
  const expected =
    chunk({ role: "assistant" }, null) + chunk({ content: "Hel" }, null) + chunk({ content: "lo" }, null) + chunk({}, "stop") + "data: [DONE]\n\n";
  assert.equal(offOut.raw, expected, "OFF streams the upstream document untouched");
});

test("OFF anthropic SSE: the converted document is byte-identical to whole-document anthropicSseToChat", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "anthropic", mode: "off" });
  env.plan = [{ text: ["Hel", "lo"] }];
  try {
    const out = await env.post(inboundBody("no-touch", true), { epochId: "epoch-off-anth-sse" });
    assert.equal(out.status, 200);
    assert.equal(env.hits.length, 1, "OFF never issues a second upstream call");
    // OFF byte-identity invariant: the client receives exactly what
    // whole-document conversion produces -- the per-frame terminal/framing
    // options used by the injection adapter must never touch this path.
    const upstreamDoc = upstreamSse("anthropic", env.plan[0]!);
    const expected = protocolConverters.anthropicSseToChat(upstreamDoc);
    assert.equal(out.raw, expected, "OFF anthropic SSE is whole-document converted bytes");
  } finally {
    await env.close();
  }
});

test("OFF chat-completions JSON: the upstream document is forwarded byte-for-byte", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "chat-completions", mode: "off" });
  env.plan = [{ text: ["plain"] }];
  try {
    const out = await env.post(inboundBody("no-touch", false), { epochId: "epoch-off-json" });
    assert.equal(out.status, 200);
    assert.equal(env.hits.length, 1);
    assert.equal(
      out.raw,
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "plain" }, finish_reason: "stop" }] }),
      "OFF JSON path forwards the upstream document byte-for-byte",
    );
  } finally {
    await env.close();
  }
});

// ---- Failure paths. Every path must release the held terminal exactly once
// ---- and leave the client with exactly one terminal event.

async function assertFailurePath(options: FixtureOptions & { plan: PlanItem[]; shape: "no-touch" | "touch-then-tool"; label: string; secondDeltas?: string[] }) {
  hardening.resetForTests();
  const env = await fixture(options);
  env.plan = options.plan;
  try {
    const out = await env.post(inboundBody(options.shape, true), { epochId: "epoch-" + options.label });
    const views = assertCleanStream(out.raw, {
      // plan §7.4: deltas the second run already emitted before its failure
      // cannot be retracted; the client legitimately receives first-run
      // deltas, any partial second-run deltas, then the replayed ORIGINAL
      // terminal -- exactly one terminal total.
      firstDeltas: [...(options.plan[0]?.text ?? []), ...(options.secondDeltas ?? [])],
      terminalFinish: "stop",
    });
    const terminalCount = views.filter((view) => view.finish !== null).length;
    assert.equal(terminalCount, 1, options.label + ": exactly one terminal event");
    // A 502 nudge attempt is retried by the hop's own bounded policy, so the
    // attempt chain consumes 1..3 calls; the invariant under test is the
    // replay of the original terminal above, not the retry count.
    assert.ok(env.hits.length >= 2, options.label + ": a remediation attempt was actually made");
    assert.ok(env.hits.length <= 4, options.label + ": the attempt chain stays bounded");
    return out;
  } finally {
    await env.close();
  }
}

test("failure second-run 502 (chat-completions SSE no-touch): original terminal replayed exactly once", async () => {
  await assertFailurePath({
    protocol: "chat-completions",
    mode: "enforce",
    label: "cc-nt-502",
    shape: "no-touch",
    plan: [{ text: ["held text"] }, { status: 502 }],
  });
});

test("failure second-run 502 (responses SSE touch-then-tool): original terminal replayed exactly once", async () => {
  await assertFailurePath({
    protocol: "responses",
    mode: "enforce",
    label: "resp-ttt-502",
    shape: "touch-then-tool",
    plan: [{ text: ["resp held"] }, { status: 502 }],
  });
});

test("failure second-run 502 (anthropic SSE no-touch): original terminal replayed exactly once", async () => {
  await assertFailurePath({
    protocol: "anthropic",
    mode: "enforce",
    label: "anth-nt-502",
    shape: "no-touch",
    plan: [{ text: ["anth held"] }, { status: 502 }],
  });
});

test("failure second-run timeout (chat-completions SSE no-touch): watchdog releases the original terminal", async () => {
  await assertFailurePath({
    protocol: "chat-completions",
    mode: "enforce",
    l2: { timeoutMs: 1200, retryBudgetMs: 1200 },
    label: "cc-nt-timeout",
    shape: "no-touch",
    plan: [{ text: ["timeout held"] }, { text: ["late"], hang: true }],
    // plan §7.4: the second run's pre-timeout delta is not retractable.
    secondDeltas: ["late"],
  });
});

test("failure second-run timeout (responses SSE no-touch): watchdog releases the original terminal", async () => {
  await assertFailurePath({
    protocol: "responses",
    mode: "enforce",
    l2: { timeoutMs: 1200, retryBudgetMs: 1200 },
    label: "resp-nt-timeout",
    shape: "no-touch",
    plan: [{ text: ["resp timeout held"] }, { text: ["late"], hang: true }],
    // plan §7.4: the second run's pre-timeout delta is not retractable.
    secondDeltas: ["late"],
  });
});

test("failure upstream drops after the terminal (responses SSE no-touch): no nudge, deterministic close, no stuck hold", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "responses", mode: "enforce" });
  env.plan = [{ text: ["dropped after terminal"], hang: true }];
  try {
    const postPromise = env.post(inboundBody("no-touch", true), { epochId: "epoch-resp-drop" });
    await waitFor(() => env.hits.length === 1 && typeof env.dropUpstream === "function", "upstream hang");
    // The first stream produced its deltas and its terminal already entered
    // the hold; now the upstream socket dies without [DONE].
    env.dropUpstream?.();
    const out = await postPromise;
    assert.equal(out.status, 200);
    assert.ok(env.hits.length <= 1, "no remediation runs off a broken first stream");
    const parsed = parseSseText(out.raw);
    const views = parsed.dataLines.map(chunkView);
    assert.deepEqual(views.map((view) => view.content).filter(Boolean), ["dropped after terminal"], "forwarded deltas survive");
  } finally {
    await env.close();
  }
});

test("failure client disconnect inside the hold window (chat-completions): release callback fires, no second upstream call", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "chat-completions", mode: "enforce", l2: { timeoutMs: 3000, retryBudgetMs: 3000 } });
  env.plan = [{ text: ["never delivered"], hang: true }];
  try {
    const postPromise = env.post(inboundBody("no-touch", true), {
      epochId: "epoch-cc-disc",
      hangUpAfterFirstByte: true,
    });
    await waitFor(() => env.hits.length === 1, "first upstream hit");
    const out = await postPromise;
    void out;
    // Settle time: the hop's client-close path must release the hold without
    // ever issuing the nudge.
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(env.hits.length, 1, "a disconnected client never earns a second upstream call");
  } finally {
    await env.close();
  }
});

test("OFF first-run upstream 502 propagates without inventing a terminal (chat-completions JSON)", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "chat-completions", mode: "off" });
  env.plan = [{ status: 502 }];
  try {
    const out = await env.post(inboundBody("no-touch", false), { epochId: "epoch-off-502" });
    assert.equal(out.status, 502);
    // The hop's own bounded 5xx retry policy (UPSTREAM_5XX_RETRY: 2 retries)
    // re-attempts a retryable upstream failure while nothing was sent; the
    // OFF guarantee under test is that the propagated document is the
    // upstream error with no invented terminal -- not the attempt count.
    assert.ok(env.hits.length >= 1 && env.hits.length <= 3, "OFF propagates without inventing a terminal");
    const parsed = JSON.parse(out.raw) as { error?: { message?: string } };
    assert.equal(typeof parsed.error?.message, "string");
  } finally {
    await env.close();
  }
});

// ---- The unresolved second run: the model ignores the nudge and silently
// ---- stops again. Exactly one attempt, then finalNoTool -- never a third.

test("second run still silent (anthropic JSON touch-then-tool): one attempt, unresolved, no forged call", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "anthropic", mode: "enforce" });
  // Distinguishable text per call: the merged document must read
  // "first silent" + "second silent" (first run's text survives, second run
  // continues the same host response, plan §7.2).
  env.plan = [
    { text: ["first silent"], text2: ["second silent"] },
  ];
  try {
    const out = await env.post(inboundBody("touch-then-tool", false), { epochId: "epoch-anth-final" });
    assert.equal(out.status, 200);
    assert.equal(env.hits.length, 2, "exactly one attempt -- never a third run");
    const view = viewJson(out.raw);
    assert.equal(view.content, "first silent" + "second silent");
    assert.deepEqual(view.toolNames, [], "no forged delivery call after the model ignored the nudge");
    assert.equal(view.finish, "stop");
  } finally {
    await env.close();
  }
});

test("second run still silent (chat-completions SSE no-touch): both texts forwarded, single second terminal", async () => {
  hardening.resetForTests();
  const env = await fixture({ protocol: "chat-completions", mode: "enforce" });
  env.plan = [
    { text: ["first"], text2: ["second"] },
  ];
  try {
    const out = await env.post(inboundBody("no-touch", true), { epochId: "epoch-cc-final" });
    assert.equal(out.status, 200);
    assert.equal(env.hits.length, 2, "the cap is one additional run");
    assertCleanStream(out.raw, { firstDeltas: ["first", "second"], terminalFinish: "stop" });
    assert.equal(out.raw.includes("[SAND_HIDDEN_PROMPT]"), false);
  } finally {
    await env.close();
  }
});
