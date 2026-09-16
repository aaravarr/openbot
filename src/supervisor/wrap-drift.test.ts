import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { OPENBOT_MARKER, type AbsPath } from "../domain/types.ts";
import {
  DEFAULT_DRIFT_POLL_MS,
  DRIFT_MARKER_RECHECK_POLLS,
  DRIFT_POLL_ENV,
  DRIFT_POLL_MAX_MS,
  DRIFT_POLL_MIN_MS,
  DRIFT_SETTLE_POLLS,
  WRAP_HEAD_BYTES,
  clampDriftPollMs,
  createWrapDriftDetector,
  driftPollMsFromEnv,
  isOfficialModeToken,
  nodeWrapDriftProbe,
  wrapHeadHasMarker,
  wrapStampKey,
  type WrapDriftVerdict,
  type WrapDriftProbe,
  type WrapFileStamp,
} from "./wrap-drift.ts";

const HOST_MAIN = "/home/box/sand-host/host-main.cjs" as AbsPath;

const WRAPPED_HEAD = `${OPENBOT_MARKER}\nvar __openbotRuntime = require('/home/box/sand-data/openbot-runtime.cjs');\n`;
const STOCK_HEAD = "function createProtoSessionProvider(client) {\n  return { getSession: function () { return 1; } };\n}\n";

/**
 * A host file in memory: one stamp and the head the probe would read. The
 * stat fields are independent knobs, which is what lets a test rename a file
 * (new ino, same size and mtime) or rewrite it in place (same stat, new head).
 */
type FakeHostFile = {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
  readonly ctimeMs: number;
  readonly head: string;
};

function fakeHost(initial: FakeHostFile) {
  let file: FakeHostFile | undefined = initial;
  const probe: WrapDriftProbe = {
    stamp() {
      if (file === undefined) {
        return undefined;
      }
      const { size, mtimeMs, ino, ctimeMs } = file;
      return { size, mtimeMs, ino, ctimeMs };
    },
    head() {
      return file?.head;
    },
  };
  return {
    probe,
    write(next: FakeHostFile): void {
      file = next;
    },
    remove(): void {
      file = undefined;
    },
  };
}

function wrapped(overrides: Partial<FakeHostFile> = {}): FakeHostFile {
  return { size: 900, mtimeMs: 1_000, ino: 41, ctimeMs: 1_000, head: WRAPPED_HEAD, ...overrides };
}

function stock(overrides: Partial<FakeHostFile> = {}): FakeHostFile {
  return { size: 640, mtimeMs: 2_000, ino: 42, ctimeMs: 2_000, head: STOCK_HEAD, ...overrides };
}

function detectorFor(
  host: ReturnType<typeof fakeHost>,
  opts: { mode?: () => string | undefined; settlePolls?: number; markerRecheckPolls?: number } = {},
) {
  return createWrapDriftDetector({
    hostMain: HOST_MAIN,
    mode: opts.mode ?? (() => "custom\n"),
    probe: host.probe,
    ...(opts.settlePolls !== undefined ? { settlePolls: opts.settlePolls } : {}),
    ...(opts.markerRecheckPolls !== undefined ? { markerRecheckPolls: opts.markerRecheckPolls } : {}),
  });
}

function polls(detector: ReturnType<typeof detectorFor>, times: number): WrapDriftVerdict[] {
  return Array.from({ length: times }, () => detector.poll());
}

test("a settled fingerprint change is reported as drift", () => {
  const host = fakeHost(wrapped());
  const detector = detectorFor(host);
  detector.rebaseline();
  host.write(stock());
  const seen = polls(detector, DRIFT_SETTLE_POLLS);
  assert.equal(seen[0]?.kind, "settling");
  const last = seen.at(-1);
  assert.equal(last?.kind, "drift");
  if (last?.kind !== "drift") {
    throw new Error("expected drift");
  }
  assert.equal(last.reason, "changed+marker-missing");
  assert.equal(last.previous, wrapStampKey(wrapped()));
  assert.equal(last.fingerprint, wrapStampKey(stock()));
});

test("an unchanged file never reports drift, however often it is polled", () => {
  const host = fakeHost(wrapped());
  const detector = detectorFor(host);
  detector.rebaseline();
  const verdicts = polls(detector, 40);
  assert.equal(
    verdicts.every((verdict) => verdict.kind === "none"),
    true,
  );
});

test("a rename replace with identical size and mtime is caught by the inode", () => {
  const host = fakeHost(wrapped({ size: 640, mtimeMs: 5_000, ctimeMs: 5_000, ino: 41 }));
  const detector = detectorFor(host);
  detector.rebaseline();
  // Same bytes-length, same mtime: only the file identity changed, which is
  // exactly what an atomic replace by Grok's updater looks like.
  host.write(stock({ size: 640, mtimeMs: 5_000, ctimeMs: 5_000, ino: 77 }));
  const verdict = polls(detector, DRIFT_SETTLE_POLLS).at(-1);
  assert.equal(verdict?.kind, "drift");
});

test("a file still being written is left alone until two polls agree", () => {
  const host = fakeHost(wrapped());
  const detector = detectorFor(host);
  detector.rebaseline();
  // Poll 1 sees B, poll 2 already sees C: neither snapshot was stable, so the
  // half-written file is never inspected.
  host.write(stock({ ino: 42 }));
  assert.equal(detector.poll().kind, "settling");
  host.write(stock({ ino: 43 }));
  assert.equal(detector.poll().kind, "settling");
  // The writer finished: the same bytes twice in a row is the stable read.
  host.write(stock({ ino: 43 }));
  assert.equal(detector.poll().kind, "drift");
});

test("an in-place rewrite that keeps every stat field is caught by the marker sweep", () => {
  const host = fakeHost(wrapped());
  const detector = detectorFor(host);
  detector.rebaseline();
  // The pathological case: same size, same mtime, same inode, stock bytes.
  host.write(wrapped({ head: STOCK_HEAD }));
  const verdicts = polls(detector, DRIFT_MARKER_RECHECK_POLLS + 2);
  const firstDrift = verdicts.findIndex((verdict) => verdict.kind === "drift");
  // One sweep every DRIFT_MARKER_RECHECK_POLLS polls, and the change itself
  // costs one settling poll first.
  assert.equal(firstDrift, DRIFT_MARKER_RECHECK_POLLS - 1);
  assert.equal(verdicts[firstDrift]?.kind === "drift" && verdicts[firstDrift].reason, "marker-missing");
  assert.equal(verdicts.filter((verdict) => verdict.kind === "drift").length, 1);
});

test("an official box never reports drift", () => {
  const host = fakeHost(wrapped());
  const detector = detectorFor(host, { mode: () => "official\n" });
  detector.rebaseline();
  host.write(stock());
  // The gate is checked after the settle, so the first settled poll is the
  // suppressed one; the second is a plain none because the baseline moved on.
  assert.equal(polls(detector, 1)[0]?.kind, "settling");
  assert.deepEqual(detector.poll(), { kind: "suppressed", reason: "official" });
  assert.equal(detector.poll().kind, "none");
});

test("a mode file that is anything but official is still custom", () => {
  const host = fakeHost(wrapped());
  const detector = detectorFor(host, { mode: () => "OFFICIAL\n" });
  detector.rebaseline();
  host.write(stock());
  assert.deepEqual(polls(detector, DRIFT_SETTLE_POLLS).at(-1)?.kind, "drift");
});

test("a missing host file is never a drift, and a returning one is", () => {
  const host = fakeHost(wrapped());
  const detector = detectorFor(host);
  detector.rebaseline();
  host.remove();
  assert.equal(
    polls(detector, 20).every((verdict) => verdict.kind === "none"),
    true,
  );
  host.write(stock());
  assert.equal(detector.poll().kind, "settling");
  assert.equal(detector.poll().kind, "drift");
});

test("rebaseline adopts whatever the tick left behind", () => {
  const host = fakeHost(wrapped());
  const detector = detectorFor(host);
  detector.rebaseline();
  host.write(stock());
  assert.equal(polls(detector, DRIFT_SETTLE_POLLS).at(-1)?.kind, "drift");
  // The repair wrote new bytes; adopting them must stop the trigger instead of
  // re-arming it forever.
  detector.rebaseline();
  assert.equal(
    polls(detector, 40).every((verdict) => verdict.kind === "none"),
    true,
  );
});

test("a probe that throws fails safe instead of taking the loop down", () => {
  const broken: WrapDriftProbe = {
    stamp() {
      throw new Error("EIO");
    },
    head() {
      throw new Error("EIO");
    },
  };
  const detector = createWrapDriftDetector({ hostMain: HOST_MAIN, mode: () => "custom\n", probe: broken });
  detector.rebaseline();
  assert.equal(
    polls(detector, 5).every((verdict) => verdict.kind === "none"),
    true,
  );
});

test("the marker check is a head check", () => {
  assert.equal(wrapHeadHasMarker(WRAPPED_HEAD), true);
  assert.equal(wrapHeadHasMarker(STOCK_HEAD), false);
  assert.equal(wrapHeadHasMarker(undefined), false);
});

test("only the literal official token means official", () => {
  const rows: [string | undefined, boolean][] = [
    ["official\n", true],
    [" official \n", true],
    ["custom\n", false],
    [undefined, false],
    ["", false],
    ["OFFICIAL", false],
    ["official-mode", false],
  ];
  for (const [raw, expected] of rows) {
    assert.equal(isOfficialModeToken(raw), expected, `token ${JSON.stringify(raw)}`);
  }
});

test("the poll cadence is configurable, bounded, and switchable off", () => {
  assert.equal(DEFAULT_DRIFT_POLL_MS, 5_000);
  assert.equal(clampDriftPollMs(5_000), 5_000);
  assert.equal(clampDriftPollMs(100), DRIFT_POLL_MIN_MS);
  assert.equal(clampDriftPollMs(600_000), DRIFT_POLL_MAX_MS);
  assert.equal(clampDriftPollMs(0), 0);
  assert.equal(clampDriftPollMs(-1), 0);
  assert.equal(clampDriftPollMs(Number.NaN), 0);
  assert.equal(driftPollMsFromEnv({}), DEFAULT_DRIFT_POLL_MS);
  assert.equal(driftPollMsFromEnv({ [DRIFT_POLL_ENV]: "1500" }), 1_500);
  assert.equal(driftPollMsFromEnv({ [DRIFT_POLL_ENV]: "0" }), 0);
  assert.equal(driftPollMsFromEnv({ [DRIFT_POLL_ENV]: "soon" }), DEFAULT_DRIFT_POLL_MS);
  assert.equal(driftPollMsFromEnv({ [DRIFT_POLL_ENV]: " " }), DEFAULT_DRIFT_POLL_MS);
});

test("the node probe reads a real file's stamp and head", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-wrap-drift-"));
  const file = path.join(dir, "host-main.cjs") as AbsPath;
  const probe = nodeWrapDriftProbe();
  try {
    assert.equal(probe.stamp(file), undefined);
    assert.equal(probe.head(file), undefined);
    fs.writeFileSync(file, WRAPPED_HEAD);
    const stamp = probe.stamp(file);
    assert.equal(stamp?.size, Buffer.byteLength(WRAPPED_HEAD));
    assert.equal(typeof stamp?.ino, "number");
    assert.equal(probe.head(file), WRAPPED_HEAD);
    // Only the head is read, however large the host file is.
    fs.writeFileSync(file, `${WRAPPED_HEAD}${"x".repeat(WRAP_HEAD_BYTES * 2)}`);
    const head = probe.head(file);
    assert.equal(head?.length, WRAP_HEAD_BYTES);
    assert.equal(wrapHeadHasMarker(head), true);
    // An atomic replace changes the inode even when the bytes are equal.
    const replacement = path.join(dir, "host-main.cjs.next");
    fs.writeFileSync(replacement, STOCK_HEAD);
    fs.renameSync(replacement, file);
    const replaced = probe.stamp(file);
    assert.equal(replaced?.size, Buffer.byteLength(STOCK_HEAD));
    assert.notEqual(wrapStampKey(replaced as WrapFileStamp), wrapStampKey(stamp as WrapFileStamp));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
