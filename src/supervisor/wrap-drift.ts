import fs from "node:fs";
import { OPENBOT_MARKER, type AbsPath } from "../domain/types.ts";

/**
 * The cheap wrap-drift probe the guard daemon runs between scheduled ticks.
 *
 * Grok Bot rewrites host-main.cjs on its own idle auto-update, which reverts
 * the chat route to stock Grok until the next scheduled guard tick notices and
 * reinstalls the wrap. That interval is minutes; a stat poll every few seconds
 * closes the window to seconds at a cost of one stat per poll.
 *
 * Why stat polling and not fs.watch: the host file lives on a sandboxed mount
 * where rename/replace delivery is not reliable -- exactly the atomic-replace
 * shape this drift uses -- and a watcher would have to be kept alive across
 * every repair. A stat poll is deterministic on every filesystem and needs no
 * long-lived descriptor.
 *
 * This module only decides that the host file is worth a look. It never
 * repairs anything: the caller routes every verdict through the same guardCustom
 * tick the schedule uses, so all of its safety rails (official is never
 * touched, keepGuard, refusals) apply unchanged.
 */

/** Default fast-poll cadence: one stat every 5 seconds. */
export const DEFAULT_DRIFT_POLL_MS = 5_000;
/** `OPENBOT_GUARD_DRIFT_POLL_MS` overrides the cadence; `0` disables the fast poll. */
export const DRIFT_POLL_ENV = "OPENBOT_GUARD_DRIFT_POLL_MS";
export const DRIFT_POLL_MIN_MS = 1_000;
export const DRIFT_POLL_MAX_MS = 60_000;
/**
 * Consecutive identical polls required before a changed file is inspected.
 * One extra interval is the debounce: a writer that is still streaming bytes
 * (a copy rather than an atomic rename) shows a different fingerprint on the
 * next poll and is left alone until it settles.
 */
export const DRIFT_SETTLE_POLLS = 2;
/**
 * Polls between two marker sweeps that run without a fingerprint change. The
 * fingerprint already covers every real rewrite; this only catches the
 * pathological "marker gone, stat unchanged" case, so it costs one 4KB read
 * about once a minute.
 */
export const DRIFT_MARKER_RECHECK_POLLS = 12;
/** How much of the host file is read for the marker check. */
export const WRAP_HEAD_BYTES = 4_096;

/**
 * The stat fields that make up a file fingerprint. `ino` is what catches an
 * atomic rename/replace even when the replacement wrote identical size and
 * mtime values; `ctimeMs` catches an in-place rewrite that kept both.
 */
export type WrapFileStamp = {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
  readonly ctimeMs: number;
};

/** The IO the poll needs. Injected so tests never touch a real filesystem. */
export type WrapDriftProbe = {
  /** stat of the host file, or undefined when it is missing or unreadable. */
  stamp(path: AbsPath): WrapFileStamp | undefined;
  /** The first bytes of the host file, or undefined when it is unreadable. */
  head(path: AbsPath): string | undefined;
};

/** Why the fast poll believes the wrap is gone. */
export type WrapDriftReason = "changed" | "changed+marker-missing" | "marker-missing";

export type WrapDriftVerdict =
  | { readonly kind: "none" }
  /** The file changed since the last poll and has not settled yet. */
  | { readonly kind: "settling" }
  /** The wrap is gone, but the box is official: the fast path must not fire. */
  | { readonly kind: "suppressed"; readonly reason: "official" }
  | {
      readonly kind: "drift";
      readonly reason: WrapDriftReason;
      readonly fingerprint: string;
      readonly previous: string | undefined;
    };

/** The verdict the caller acts on: the wrap is gone and this box is custom. */
export type WrapDriftFinding = Extract<WrapDriftVerdict, { readonly kind: "drift" }>;

export type WrapDriftDetector = {
  /** One cheap poll. Never throws, never repairs. */
  poll(): WrapDriftVerdict;
  /** Adopt the current file as the post-repair baseline. */
  rebaseline(): void;
};

export type WrapDriftDetectorOpts = {
  readonly hostMain: AbsPath;
  /**
   * The mode token. The fast path is suppressed while it is official: an
   * official box is supposed to run a stock host file, so a missing wrap there
   * is the desired state, not drift.
   */
  readonly mode: () => string | undefined;
  readonly probe?: WrapDriftProbe | undefined;
  readonly settlePolls?: number | undefined;
  readonly markerRecheckPolls?: number | undefined;
};

export function nodeWrapDriftProbe(): WrapDriftProbe {
  return {
    stamp(path) {
      try {
        const stat = fs.statSync(path);
        return {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ino: Number(stat.ino),
          ctimeMs: stat.ctimeMs,
        };
      } catch {
        // Missing or unreadable: not a wrap-drift signature. The scheduled tick
        // owns a host file that is gone (its repair refuses with host-missing).
        return undefined;
      }
    },
    head(path) {
      let fd: number | undefined;
      try {
        fd = fs.openSync(path, "r");
        const buffer = Buffer.allocUnsafe(WRAP_HEAD_BYTES);
        const read = fs.readSync(fd, buffer, 0, WRAP_HEAD_BYTES, 0);
        return buffer.subarray(0, read).toString("utf8");
      } catch {
        return undefined;
      } finally {
        if (fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {
            /* the descriptor is already gone */
          }
        }
      }
    },
  };
}

/** 0 means "no fast poll". Garbage falls back to the default cadence. */
export function clampDriftPollMs(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) {
    return 0;
  }
  return Math.min(DRIFT_POLL_MAX_MS, Math.max(DRIFT_POLL_MIN_MS, Math.round(raw)));
}

export function driftPollMsFromEnv(env: NodeJS.ProcessEnv, fallback: number = DEFAULT_DRIFT_POLL_MS): number {
  const raw = env[DRIFT_POLL_ENV]?.trim();
  if (raw === undefined || raw === "") {
    return clampDriftPollMs(fallback);
  }
  if (raw === "0") {
    return 0;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? clampDriftPollMs(parsed) : clampDriftPollMs(fallback);
}

/** The fingerprint a stamp is compared by. Every field is part of it. */
export function wrapStampKey(stamp: WrapFileStamp): string {
  return `${String(stamp.ino)}:${String(stamp.size)}:${String(stamp.mtimeMs)}:${String(stamp.ctimeMs)}`;
}

/**
 * The marker must be in the head: the wrap header is the first line of a
 * wrapped host file (see src/host/wrap.ts). A stock file never starts with it.
 */
export function wrapHeadHasMarker(head: string | undefined): boolean {
  return head !== undefined && head.includes(OPENBOT_MARKER);
}

/**
 * The strict mode rule, shared with the service (`wrapMode` in src/ui/server.ts):
 * only an exact "official" token is official, so an unreadable mode file can
 * never hide a custom box. Kept local on purpose -- importing the UI service
 * into the guard daemon would drag a listener into the supervisor.
 */
export function isOfficialModeToken(raw: string | undefined): boolean {
  return raw?.trim() === "official";
}

export function createWrapDriftDetector(opts: WrapDriftDetectorOpts): WrapDriftDetector {
  const probe = opts.probe ?? nodeWrapDriftProbe();
  const settlePolls = Math.max(1, Math.trunc(opts.settlePolls ?? DRIFT_SETTLE_POLLS));
  const markerRecheckPolls = Math.max(1, Math.trunc(opts.markerRecheckPolls ?? DRIFT_MARKER_RECHECK_POLLS));
  /** The file as the last completed repair (or the last accepted look) left it. */
  let baseline: string | undefined;
  /** Whether the wrap marker was in the head at that same baseline. */
  let baselineMarkerOk = true;
  /** The fingerprint seen by the previous poll, for the settle debounce. */
  let lastSeen: string | undefined;
  let stablePolls = 0;
  let steps = 0;
  let lastMarkerStep = 0;

  const fingerprintNow = (): string | undefined => {
    try {
      const stamp = probe.stamp(opts.hostMain);
      return stamp === undefined ? undefined : wrapStampKey(stamp);
    } catch {
      // A probe that cannot stat is a probe that saw nothing: fail safe, and
      // let the scheduled tick keep being the authority.
      return undefined;
    }
  };

  const readMarker = (): boolean => {
    try {
      return wrapHeadHasMarker(probe.head(opts.hostMain));
    } catch {
      return false;
    }
  };

  return {
    poll(): WrapDriftVerdict {
      steps += 1;
      const fingerprint = fingerprintNow();
      if (fingerprint === undefined) {
        // No host file: the scheduled tick owns that. Clearing lastSeen makes a
        // file that comes back count as a change on its first settled poll.
        lastSeen = undefined;
        stablePolls = 0;
        return { kind: "none" };
      }
      if (fingerprint === lastSeen) {
        stablePolls += 1;
      } else {
        lastSeen = fingerprint;
        stablePolls = 1;
      }
      if (stablePolls < settlePolls) {
        return { kind: "settling" };
      }
      const changed = fingerprint !== baseline;
      const markerDue = steps - lastMarkerStep >= markerRecheckPolls;
      if (!changed && !markerDue) {
        return { kind: "none" };
      }
      lastMarkerStep = steps;
      const markerOk = readMarker();
      const previous = baseline;
      const markerWasThere = baselineMarkerOk;
      // Arm the new baseline before the caller repairs. One drift costs at most
      // one fast attempt: a repair that is refused, or one that leaves the file
      // unchanged, is retried by the scheduled tick, never by a 5s poll loop.
      baseline = fingerprint;
      baselineMarkerOk = markerOk;
      // A marker sweep reports only a marker that was there and is now gone. A
      // baseline that already knows the wrap is missing stays quiet until the
      // bytes move again, so a refused repair cannot become a poll-driven loop.
      const drifted = changed || (markerWasThere && !markerOk);
      if (!drifted) {
        return { kind: "none" };
      }
      if (isOfficialModeToken(opts.mode())) {
        return { kind: "suppressed", reason: "official" };
      }
      const reason: WrapDriftReason =
        changed && !markerOk ? "changed+marker-missing" : changed ? "changed" : "marker-missing";
      return { kind: "drift", reason, fingerprint, previous };
    },
    rebaseline(): void {
      const fingerprint = fingerprintNow();
      baseline = fingerprint;
      baselineMarkerOk = readMarker();
      lastSeen = fingerprint;
      // A rebaseline follows a completed tick, so the file is settled by
      // definition; the next poll must not report the change it just adopted.
      stablePolls = settlePolls;
      steps += 1;
      lastMarkerStep = steps;
    },
  };
}
