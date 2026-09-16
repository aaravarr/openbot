import assert from "node:assert/strict";
import test from "node:test";
import { type AbsPath } from "../domain/types.ts";
import { appendWrapDriftEvent, guardEventsPath, wrapDriftEventRow, type GuardEventSink } from "./guard-events.ts";
import { boxPathsFrom, joinAbs, type BoxPaths } from "./paths.ts";
import { type FsDeps, type ProcDeps } from "./procs.ts";

const HOST_MAIN = "/home/box/sand-host/host-main.cjs" as AbsPath;

type Ctx = { readonly paths: BoxPaths; readonly deps: { paths: BoxPaths; fs: FsDeps; procs: ProcDeps } };

function setup(): Ctx {
  const paths = boxPathsFrom({
    repoRoot: "/tmp/openbot-events-repo",
    sandData: "/tmp/openbot-events-data",
    hostMain: String(HOST_MAIN),
  });
  const fs: FsDeps = {
    read: () => undefined,
    write: () => {},
    copy: () => {},
    remove: () => {},
    exists: () => false,
    mkdirp: () => {},
  };
  return { paths, deps: { paths, fs, procs: {} as ProcDeps } };
}

function recordingSink(): { sink: GuardEventSink; lines: { path: string; line: string }[] } {
  const lines: { path: string; line: string }[] = [];
  return {
    lines,
    sink: {
      append(path, line) {
        lines.push({ path: String(path), line });
      },
    },
  };
}

test("a wrap-drift row carries the shape the control page reads", () => {
  const at = new Date("2026-08-20T10:00:00.000Z");
  const row = wrapDriftEventRow(
    { hostMain: HOST_MAIN, trigger: "drift-poll", reason: "changed+marker-missing", modeRepaired: true },
    at,
    "11111111-2222-3333-4444-555555555555",
  );
  assert.equal(row.id, "11111111-2222-3333-4444-555555555555");
  assert.equal(row.at, "2026-08-20T10:00:00.000Z");
  assert.equal(row.type, "wrap-drift");
  assert.equal(row.severity, "WARN");
  assert.match(String(row.message), /fast drift poll/);
  assert.match(String(row.message), /changed\+marker-missing/);
  assert.match(String(row.message), /host-main\.cjs/);
  assert.deepEqual(row.metadata, {
    source: "guard-daemon",
    trigger: "drift-poll",
    reason: "changed+marker-missing",
    modeRepaired: true,
    hostMain: HOST_MAIN,
  });
});

test("each tick trigger names itself, and an unknown reason is simply absent", () => {
  const labels: [("schedule" | "drift-poll" | "manual"), RegExp][] = [
    ["schedule", /scheduled guard tick/],
    ["drift-poll", /fast drift poll/],
    ["manual", /one-shot guard tick/],
  ];
  for (const [trigger, pattern] of labels) {
    const row = wrapDriftEventRow({ hostMain: HOST_MAIN, trigger, modeRepaired: false });
    assert.match(String(row.message), pattern);
    const metadata = row.metadata as Record<string, unknown>;
    assert.equal(metadata.trigger, trigger);
    assert.equal("reason" in metadata, false);
  }
});

test("the events file is the one the control service reads", () => {
  const ctx = setup();
  assert.equal(String(guardEventsPath(ctx.deps, {})), String(joinAbs(ctx.paths.sandData, "openbot-events.jsonl")));
  assert.equal(
    String(guardEventsPath(ctx.deps, { OPENBOT_SAND_DATA: "/home/box/other-sand" })),
    "/home/box/other-sand/openbot-events.jsonl",
  );
  // A relative or empty override is not a path: the box's own sand data wins.
  assert.equal(String(guardEventsPath(ctx.deps, { OPENBOT_SAND_DATA: "relative/dir" })), String(joinAbs(ctx.paths.sandData, "openbot-events.jsonl")));
  assert.equal(String(guardEventsPath(ctx.deps, { OPENBOT_SAND_DATA: "  " })), String(joinAbs(ctx.paths.sandData, "openbot-events.jsonl")));
});

test("a drift event appends one JSON line", () => {
  const ctx = setup();
  const { sink, lines } = recordingSink();
  appendWrapDriftEvent(ctx.deps, { hostMain: HOST_MAIN, trigger: "schedule", modeRepaired: false }, sink, {});
  assert.equal(lines.length, 1);
  assert.equal(lines[0]?.path, String(joinAbs(ctx.paths.sandData, "openbot-events.jsonl")));
  assert.equal(lines[0]?.line.endsWith("\n"), true);
  const row = JSON.parse(lines[0]?.line ?? "") as Record<string, unknown>;
  assert.equal(row.type, "wrap-drift");
  assert.equal((row.metadata as Record<string, unknown>).trigger, "schedule");
});

test("an event write that fails never escapes", () => {
  const ctx = setup();
  const angry: GuardEventSink = {
    append() {
      throw new Error("EROFS: read-only file system");
    },
  };
  assert.doesNotThrow(() => {
    appendWrapDriftEvent(ctx.deps, { hostMain: HOST_MAIN, trigger: "drift-poll", modeRepaired: true }, angry, {});
  });
});
