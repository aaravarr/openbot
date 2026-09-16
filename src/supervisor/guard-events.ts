import fs from "node:fs";
import crypto from "node:crypto";
import { type AbsPath } from "../domain/types.ts";
import { type SupervisorDeps } from "./observe.ts";
import { joinAbs, parseAbsPath } from "./paths.ts";

/**
 * Guard-side observability events.
 *
 * The guard daemon is a detached process: it cannot reach the control
 * service's request-log store (payload/request-log.cjs is a CommonJS module
 * loaded by that service), so a wrap drift it repairs would otherwise be
 * visible only in openbot-guard.log -- a file the user has to go looking for.
 * That store's appendEvent() is, however, nothing more than an append of one
 * JSON row to `<sand>/openbot-events.jsonl`, and the control page's
 * /api/logs/events re-reads that file on every request. Appending the same row
 * shape here therefore puts guard drift in the UI's event list without a
 * second log to read and without touching the payload store.
 *
 * Best-effort by construction: an event write must never fail a repair.
 */

export const GUARD_EVENT_SOURCE = "guard-daemon";
/** The events log the control service reads. Name mirrors payload/request-log.cjs. */
export const GUARD_EVENTS_FILE = "openbot-events.jsonl";
export const WRAP_DRIFT_EVENT_TYPE = "wrap-drift";

/** What ran the tick that produced an event. */
export type GuardTickTrigger =
  /** The regular interval tick. */
  | "schedule"
  /** The fast stat poll firing between two scheduled ticks. */
  | "drift-poll"
  /** An operator's one-shot `openbot guard` tick. */
  | "manual";

export type WrapDriftEventInput = {
  readonly hostMain: AbsPath;
  readonly trigger: GuardTickTrigger;
  /** The fast-poll verdict that fired, when the trigger was the poll. */
  readonly reason?: string | undefined;
  readonly modeRepaired: boolean;
};

/** One already-serialized JSON line, appended. Injected so tests stay off-disk. */
export type GuardEventSink = {
  append(path: AbsPath, line: string): void;
};

/**
 * Append-only writer. No mkdirp on purpose: the sand data directory is owned
 * by the install and the service, and a missing one must drop the event
 * quietly rather than create directories from a guard tick.
 */
export function nodeGuardEventSink(): GuardEventSink {
  return {
    append(path, line) {
      fs.appendFileSync(path, line, "utf8");
    },
  };
}

/**
 * Where the control service reads events from. Mirrors sandDataDir() in
 * payload/request-log.cjs (OPENBOT_SAND_DATA, then the box's own sand data):
 * writing anywhere else would put the row in a file the control page never
 * reads.
 */
export function guardEventsPath(deps: SupervisorDeps, env: NodeJS.ProcessEnv = process.env): AbsPath {
  const override = env.OPENBOT_SAND_DATA?.trim();
  if (override !== undefined && override.startsWith("/")) {
    try {
      return joinAbs(parseAbsPath(override), GUARD_EVENTS_FILE);
    } catch {
      /* an unusable override falls back to the box's own sand data */
    }
  }
  return joinAbs(deps.paths.sandData, GUARD_EVENTS_FILE);
}

/** Same id shape the request-log store accepts (a UUID passes its validation). */
export function guardEventId(): string {
  return crypto.randomUUID();
}

function triggerLabel(trigger: GuardTickTrigger): string {
  switch (trigger) {
    case "drift-poll":
      return "fast drift poll";
    case "manual":
      return "one-shot guard tick";
    default:
      return "scheduled guard tick";
  }
}

/**
 * The row an operator sees. Shape and field names match appendEvent() in
 * payload/request-log.cjs so the control page renders it as-is.
 */
export function wrapDriftEventRow(
  input: WrapDriftEventInput,
  at: Date = new Date(),
  id: string = guardEventId(),
): Record<string, unknown> {
  const reason = input.reason === undefined ? "" : ` (${input.reason})`;
  return {
    id,
    at: at.toISOString(),
    type: WRAP_DRIFT_EVENT_TYPE,
    severity: "WARN",
    message: `Host wrap drift repaired on the ${triggerLabel(input.trigger)}${reason}: ${
      input.hostMain
    } was reinstalled with the openbot wrap.`,
    metadata: {
      source: GUARD_EVENT_SOURCE,
      trigger: input.trigger,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      modeRepaired: input.modeRepaired,
      hostMain: input.hostMain,
    },
  };
}

export function appendWrapDriftEvent(
  deps: SupervisorDeps,
  input: WrapDriftEventInput,
  sink: GuardEventSink = nodeGuardEventSink(),
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    sink.append(guardEventsPath(deps, env), `${JSON.stringify(wrapDriftEventRow(input))}\n`);
  } catch {
    /* best-effort: the guard log row and stderr still carry the repair */
  }
}
