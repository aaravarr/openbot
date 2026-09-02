import assert from "node:assert/strict";
import test from "node:test";
import {
  PAIR_WINDOW_MS,
  findPairById,
  pairChannels,
  pairContainsId,
  pairError,
  pairIds,
  pairKey,
  pairLatency,
  pairLogRows,
  pairModel,
  pairOpenId,
  pairStartedAt,
  pairStatus,
  pairStream,
  pairTokens,
  type PairableLog,
} from "./pair-logs.ts";

function row(partial: Partial<PairableLog> & Pick<PairableLog, "id" | "startedAt">): PairableLog {
  return {
    status: 200,
    ok: true,
    ...partial,
  };
}

test("pairLogRows joins hop and custom-host for one custom turn", () => {
  const hop = row({
    id: "hop-1",
    channel: "hop",
    model: "glm-5.3-flash",
    startedAt: "2026-09-02T17:00:00.080Z",
    latencyMs: 1200,
    totalTokens: 400,
    stream: true,
  });
  const harness = row({
    id: "host-1",
    channel: "custom-host",
    model: "glm-5.3-flash",
    startedAt: "2026-09-02T17:00:00.010Z",
    latencyMs: 1300,
    stream: true,
  });
  const pairs = pairLogRows([hop, harness]);
  assert.equal(pairs.length, 1);
  const first = pairs[0];
  assert.equal(first?.kind, "pair");
  if (first?.kind !== "pair") return;
  assert.equal(first.hop.id, "hop-1");
  assert.equal(first.harness.id, "host-1");
  assert.deepEqual(pairChannels(first), ["hop", "custom-host"]);
  assert.equal(pairStartedAt(first), harness.startedAt);
  assert.equal(pairModel(first), "glm-5.3-flash");
  assert.equal(pairLatency(first), 1300);
  assert.equal(pairTokens(first), 400);
  assert.equal(pairStream(first), true);
  assert.equal(pairOpenId(first), "hop-1");
  assert.deepEqual(pairIds(first), ["hop-1", "host-1"]);
  assert.equal(pairKey(first), "hop-1+host-1");
  assert.equal(pairContainsId(first, "host-1"), true);
});

test("pairLogRows keeps official rows single", () => {
  const official = row({
    id: "off-1",
    channel: "official",
    model: "grok-4.5",
    startedAt: "2026-09-02T17:00:00.000Z",
  });
  const hop = row({
    id: "hop-1",
    channel: "hop",
    model: "grok-4.5",
    startedAt: "2026-09-02T17:00:00.020Z",
  });
  const pairs = pairLogRows([official, hop]);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0]?.kind, "single");
  if (pairs[0]?.kind !== "single") return;
  assert.equal(pairs[0].record.id, "off-1");
  assert.equal(pairs[1]?.kind, "single");
});

test("pairLogRows treats missing channel as hop", () => {
  const hop = row({
    id: "hop-legacy",
    model: "kimi-k2",
    startedAt: "2026-09-02T17:00:00.040Z",
  });
  const harness = row({
    id: "host-legacy",
    channel: "custom-host",
    model: "kimi-k2",
    startedAt: "2026-09-02T17:00:00.000Z",
  });
  const pairs = pairLogRows([hop, harness]);
  assert.equal(pairs[0]?.kind, "pair");
});

test("pairLogRows does not join different models", () => {
  const hop = row({
    id: "hop-1",
    channel: "hop",
    model: "glm-5.3-flash",
    startedAt: "2026-09-02T17:00:00.040Z",
  });
  const harness = row({
    id: "host-1",
    channel: "custom-host",
    model: "deepseek-chat",
    startedAt: "2026-09-02T17:00:00.000Z",
  });
  const pairs = pairLogRows([hop, harness]);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0]?.kind, "single");
  assert.equal(pairs[1]?.kind, "single");
});

test("pairLogRows does not join rows outside the time window", () => {
  const hop = row({
    id: "hop-1",
    channel: "hop",
    model: "glm-5.3-flash",
    startedAt: "2026-09-02T17:00:20.000Z",
  });
  const harness = row({
    id: "host-1",
    channel: "custom-host",
    model: "glm-5.3-flash",
    startedAt: "2026-09-02T17:00:00.000Z",
  });
  const delta = Date.parse(hop.startedAt) - Date.parse(harness.startedAt);
  assert.ok(delta > PAIR_WINDOW_MS);
  const pairs = pairLogRows([hop, harness]);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0]?.kind, "single");
  assert.equal(pairs[1]?.kind, "single");
});

test("pairLogRows matches consecutive same-model turns to the nearest mate", () => {
  const host1 = row({
    id: "host-1",
    channel: "custom-host",
    model: "glm-5.3-flash",
    startedAt: "2026-09-02T17:00:00.000Z",
  });
  const hop1 = row({
    id: "hop-1",
    channel: "hop",
    model: "glm-5.3-flash",
    startedAt: "2026-09-02T17:00:00.050Z",
  });
  const host2 = row({
    id: "host-2",
    channel: "custom-host",
    model: "glm-5.3-flash",
    startedAt: "2026-09-02T17:00:00.400Z",
  });
  const hop2 = row({
    id: "hop-2",
    channel: "hop",
    model: "glm-5.3-flash",
    startedAt: "2026-09-02T17:00:00.450Z",
  });
  // API order is newest-first.
  const pairs = pairLogRows([hop2, host2, hop1, host1]);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0]?.kind, "pair");
  assert.equal(pairs[1]?.kind, "pair");
  if (pairs[0]?.kind !== "pair" || pairs[1]?.kind !== "pair") return;
  assert.equal(pairs[0].hop.id, "hop-2");
  assert.equal(pairs[0].harness.id, "host-2");
  assert.equal(pairs[1].hop.id, "hop-1");
  assert.equal(pairs[1].harness.id, "host-1");
});

test("pairLogRows leaves an unmatched hop or harness as a single row", () => {
  const hop = row({
    id: "hop-only",
    channel: "hop",
    model: "glm-5.3-flash",
    startedAt: "2026-09-02T17:00:00.000Z",
  });
  const harness = row({
    id: "host-only",
    channel: "custom-host",
    model: "kimi-k2",
    startedAt: "2026-09-02T17:00:00.000Z",
  });
  const pairs = pairLogRows([hop, harness]);
  assert.equal(pairs.length, 2);
  assert.deepEqual(
    pairs.map((p) => (p.kind === "single" ? p.record.id : "")),
    ["hop-only", "host-only"],
  );
});

test("pairLogRows preserves input order and does not pair two hops", () => {
  const a = row({
    id: "hop-a",
    channel: "hop",
    model: "glm-5.3-flash",
    startedAt: "2026-09-02T17:00:01.000Z",
  });
  const b = row({
    id: "hop-b",
    channel: "hop",
    model: "glm-5.3-flash",
    startedAt: "2026-09-02T17:00:01.020Z",
  });
  const pairs = pairLogRows([b, a]);
  assert.equal(pairs.length, 2);
  assert.equal(pairs[0]?.kind, "single");
  assert.equal(pairs[1]?.kind, "single");
  if (pairs[0]?.kind !== "single" || pairs[1]?.kind !== "single") return;
  assert.equal(pairs[0].record.id, "hop-b");
  assert.equal(pairs[1].record.id, "hop-a");
});

test("pair helpers surface the failed layer's status and error", () => {
  const hop = row({
    id: "hop-1",
    channel: "hop",
    model: "glm-5.3-flash",
    startedAt: "2026-09-02T17:00:00.040Z",
    status: 502,
    ok: false,
    error: "upstream 502",
  });
  const harness = row({
    id: "host-1",
    channel: "custom-host",
    model: "glm-5.3-flash",
    startedAt: "2026-09-02T17:00:00.000Z",
    status: 200,
    ok: true,
  });
  const pairs = pairLogRows([hop, harness]);
  const first = pairs[0];
  assert.equal(first?.kind, "pair");
  if (!first) return;
  assert.equal(pairStatus(first), 502);
  assert.equal(pairError(first), "upstream 502");
  assert.equal(findPairById(pairs, "host-1")?.kind, "pair");
});
