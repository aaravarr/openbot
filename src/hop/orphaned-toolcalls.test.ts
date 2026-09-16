import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const messagesLib = require(path.join(here, "../../payload/openai-messages.cjs")) as {
  toOpenAIMessages: (msgs: unknown) => Msg[];
  repairOrphanedToolCalls: (msgs: unknown) => Msg[];
  TOOL_CALL_INCOMPLETE_CONTENT: string;
};
const imageRead = require(path.join(here, "../../payload/image-read.cjs")) as {
  enrichImageReads: (messages: unknown) => Promise<Msg[]>;
  isInjectedImageMessage: (msg: unknown) => boolean;
};
const hardening = require(path.join(here, "../../payload/injection-hardening.cjs")) as {
  classifyDebt: (options: { messages: Msg[] }) => { debtShape: string; debtState: string };
};
const converters = require(path.join(here, "../../payload/protocol-converters.cjs")) as {
  chatToAnthropic: (body: unknown) => { messages: { role: string; content: unknown }[] };
};

type ToolCall = { id: string; type: string; function: { name: string; arguments: string } };
type Msg = {
  role: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
};

// --- The real incident shape -------------------------------------------------
//
// 2026-09-11 22:59:54-23:00:30 (Beijing): the product bot burned three turns
// on the same upstream 400. Captured hop bodies (openbot-request-bodies
// 4a36eb35-9fb6-43df-af40-8c2771f675a8.json et al., 392 messages each):
//
//   msg[254] role=tool  tool_call_id=call_fada0153ac704e0a81cd75d0
//   msg[255] role=assistant tool_calls=[call_0821295a6ee0496e89d82e83:Read,
//                                       call_8ccd50335eb9470ba2500828:Read]
//   msg[256] role=tool  tool_call_id=call_0821295a6ee0496e89d82e83
//   msg[257] role=user  "[Image attached from Read: .../01-list.png]" + image_url
//   msg[258] role=tool  tool_call_id=call_8ccd50335eb9470ba2500828
//
// The assistant tool_calls block is interrupted after its FIRST result; the
// upstream rejected every attempt with: "An assistant message with 'tool_calls'
// must be followed by tool messages responding to each 'tool_call_id'."
// The host-side body (39c8d2d3-... host-stream) is VALID: assistant -> tool ->
// tool, adjacent. The corruption was born on the hop, between
// toOpenAIMessages and the upstream call - enrichImageReads dropped its
// role=user image message right after the FIRST tool result of the parallel
// pair.

const INCIDENT_CALL_A = "call_0821295a6ee0496e89d82e83";
const INCIDENT_CALL_B = "call_8ccd50335eb9470ba2500828";

// Minimal hop-outbound fixture derived from the captured body.
function incidentShape(): Msg[] {
  return [
    { role: "user", content: "compare the two review screenshots" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: INCIDENT_CALL_A, type: "function", function: { name: "Read", arguments: '{"path":"/workspace/xhs-ops/reqs/review/01-list.png"}' } },
        { id: INCIDENT_CALL_B, type: "function", function: { name: "Read", arguments: '{"path":"/workspace/xhs-ops/reqs/review/02-detail-overlay.png"}' } },
      ],
    },
    { role: "tool", tool_call_id: INCIDENT_CALL_A, content: "Read image file: 01-list.png" },
    injectedUserImage("01-list.png"),
    { role: "tool", tool_call_id: INCIDENT_CALL_B, content: "Read image file: 02-detail-overlay.png" },
  ];
}

function injectedUserImage(label: string): Msg {
  return {
    role: "user",
    content: [
      { type: "text", text: "[Image attached from Read: " + label + "]" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ],
  };
}

// Strict validator with the exact OpenAI rule that rejected the incident
// bodies: after an assistant tool_calls message, ALL results must appear
// before any other role intervenes.
function adjacencyViolations(messages: Msg[]): string[] {
  const problems: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const got: string[] = [];
    let k = i + 1;
    while (k < messages.length && messages[k]!.role === "tool") {
      got.push(messages[k]!.tool_call_id ?? "");
      k += 1;
    }
    for (const call of m.tool_calls) {
      if (!got.includes(call.id)) {
        problems.push(
          "assistant@" + i + " call " + call.id + " results are not adjacent (got [" + got.join(",") + "], next role " + (messages[k]?.role ?? "END") + "@" + k + ")",
        );
      }
    }
  }
  return problems;
}

test("repair fixes the real incident shape: split run made contiguous, injection preserved", () => {
  const out = messagesLib.repairOrphanedToolCalls(incidentShape());
  assert.deepEqual(adjacencyViolations(out), [], "incident shape must repair to adjacent results");
  assert.equal(out.length, 5, "nothing dropped, nothing added");
  assert.equal(out[2]?.role, "tool");
  assert.equal(out[2]?.tool_call_id, INCIDENT_CALL_A);
  assert.equal(out[3]?.role, "tool");
  assert.equal(out[3]?.tool_call_id, INCIDENT_CALL_B, "second result now directly follows the first");
  assert.equal(out[4]?.role, "user", "injected image message survives, moved after the run");
  assert.deepEqual((out[4]?.content as { type: string }[])?.map((p) => p.type), ["text", "image_url"]);
});

test("an already-valid array is byte-identical", () => {
  const valid: Msg[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    {
      role: "assistant",
      content: "working",
      tool_calls: [
        { id: "call_x1", type: "function", function: { name: "Shell", arguments: "{}" } },
        { id: "call_x2", type: "function", function: { name: "Read", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_x1", content: "r1" },
    { role: "tool", tool_call_id: "call_x2", content: "r2" },
    { role: "assistant", content: "done" },
    { role: "user", content: "thanks" },
  ];
  const snapshot = JSON.parse(JSON.stringify(valid));
  const out = messagesLib.repairOrphanedToolCalls(valid);
  assert.deepEqual(out, snapshot, "valid arrays must pass through byte-identical");
  // Same array in call order x2,x1 also stays put (order follows the call
  // order, which this fixture already matches).
  assert.equal(out.map((m) => m.role).join(","), snapshot.map((m: Msg) => m.role).join(","));
});

test("a call with no result anywhere gets an explicit did-not-complete row, never a fake success", () => {
  const msgs: Msg[] = [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "call_gone", type: "function", function: { name: "Shell", arguments: "{}" } }],
    },
    { role: "user", content: "and now?" },
  ];
  const out = messagesLib.repairOrphanedToolCalls(msgs);
  assert.deepEqual(adjacencyViolations(out), []);
  assert.equal(out.length, 4);
  const repaired = out[2]!;
  assert.equal(repaired.role, "tool");
  assert.equal(repaired.tool_call_id, "call_gone");
  assert.equal(repaired.content, "[tool call did not complete: no result recorded]");
});

test("the repair sentinel is invisible to the injection debt classifier", () => {
  // Regression guard for the fix-of-the-fix: counting the synthesized row as
  // execution chronology flipped a not-owed touch-no-tool tail into owed
  // touch-then-tool and spawned a remediation upstream call (caught by
  // injection-integration "touch-no-tool" tests during development).
  const tail: Msg[] = [
    { role: "user", content: "please do the thing" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "touch-1", type: "function", function: { name: "ReactToMessage", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "touch-1", content: messagesLib.TOOL_CALL_INCOMPLETE_CONTENT },
  ];
  const view = hardening.classifyDebt({ messages: tail });
  assert.equal(view.debtShape, "touch-no-tool", "sentinel row must not create tool-after-touch chronology");
  assert.equal(view.debtState, "not-owed");
});

test("repair is deterministic and idempotent", () => {
  const once = messagesLib.repairOrphanedToolCalls(incidentShape());
  const twice = messagesLib.repairOrphanedToolCalls(once);
  assert.deepEqual(twice, once);
  assert.deepEqual(messagesLib.repairOrphanedToolCalls(incidentShape()), once);
});

test("belated tool row inside a later window is dragged to its own block", () => {
  const msgs: Msg[] = [
    { role: "user", content: "start" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "call_p", type: "function", function: { name: "Read", arguments: "{}" } },
        { id: "call_q", type: "function", function: { name: "Read", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "call_p", content: "rp" },
    // result of call_q was emitted late, after a user turn:
    { role: "user", content: "nudge" },
    { role: "tool", tool_call_id: "call_q", content: "rq" },
  ];
  const out = messagesLib.repairOrphanedToolCalls(msgs);
  assert.deepEqual(adjacencyViolations(out), []);
  const roles = out.map((m) => m.role).join(",");
  assert.equal(roles, "user,assistant,tool,tool,user", "tool run becomes contiguous, nudge preserved after it");
  assert.equal(out[3]?.tool_call_id, "call_q");
  assert.equal(out[4]?.content, "nudge");
});

test("tool result with no matching call anywhere is kept verbatim", () => {
  const msgs: Msg[] = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "plain text, no calls" },
    { role: "tool", tool_call_id: "call_orphan_result", content: "leftover" },
  ];
  const snapshot = JSON.parse(JSON.stringify(msgs));
  const out = messagesLib.repairOrphanedToolCalls(msgs);
  assert.deepEqual(out, snapshot, "no call block: the array passes through untouched");
});

test("enrichImageReads no longer splits a parallel tool-result run", async () => {
  // Exactly the hop-side sequence that produced msg[256]/257/258 in the
  // incident bodies. The first read targets a real PNG on disk; the second
  // read target is missing, so only the first gets an injection.
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-orphan-"));
  try {
    const png = path.join(dir, "01-list.png");
    writeFileSync(png, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ));
    const msgs: Msg[] = [
      { role: "user", content: "look" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_a", type: "function", function: { name: "Read", arguments: JSON.stringify({ path: png }) } },
          { id: "call_b", type: "function", function: { name: "Read", arguments: JSON.stringify({ path: path.join(dir, "missing.png") }) } },
        ],
      },
      { role: "tool", tool_call_id: "call_a", content: "no image data here" },
      { role: "tool", tool_call_id: "call_b", content: "no image data here" },
      { role: "user", content: "continue" },
    ];
    const out = await imageRead.enrichImageReads(msgs);
    // Old behavior: user,assistant,tool,USER,tool,USER -> 6 rows with the run
    // split. New behavior: the injection waits for the run to end.
    assert.equal(out.length, 6);
    const roles = out.map((m) => m.role).join(",");
    assert.equal(roles, "user,assistant,tool,tool,user,user", "tool run stays contiguous; injections come after it");
    const injected = out.filter((m) => imageRead.isInjectedImageMessage(m));
    assert.equal(injected.length, 1, "only the readable file is injected");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end-to-end: incident host turn through toOpenAIMessages + enrichment + repair is valid", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-orphan-e2e-"));
  try {
    const png = path.join(dir, "shot.png");
    writeFileSync(png, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ));
    // Host-format turn equivalent to the captured host body (39c8d2d3):
    // assistant content parts carrying two tool-call parts, then two
    // tool-result rows.
    const host = [
      { role: "user", content: "look at both" },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "call_h1", toolName: "Read", args: { path: png } },
          { type: "tool-call", toolCallId: "call_h2", toolName: "Read", args: { path: path.join(dir, "nope.png") } },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_h1", result: "img bytes" }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_h2", result: "img bytes" }] },
    ];
    let msgs = messagesLib.toOpenAIMessages(host) as Msg[];
    msgs = (await imageRead.enrichImageReads(msgs)) as Msg[];
    msgs = messagesLib.repairOrphanedToolCalls(msgs);
    assert.deepEqual(adjacencyViolations(msgs), [], "full hop pipeline output must satisfy strict adjacency");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("chatToAnthropic serializes consecutive tool rows as one user turn of tool_result blocks", () => {
  const body = converters.chatToAnthropic({
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_m", type: "function", function: { name: "Read", arguments: "{}" } },
          { id: "call_n", type: "function", function: { name: "Read", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_m", content: "rm" },
      { role: "tool", tool_call_id: "call_n", content: "rn" },
    ],
  });
  const msgs = body.messages as { role: string; content: { type: string }[] }[];
  assert.equal(msgs.length, 3, "user + assistant + ONE user turn of results, not four");
  assert.equal(msgs[1]?.role, "assistant");
  assert.equal(msgs[2]?.role, "user");
  assert.deepEqual(
    (msgs[2]?.content ?? []).map((b) => ({ type: b.type })),
    [{ type: "tool_result" }, { type: "tool_result" }],
  );
});
