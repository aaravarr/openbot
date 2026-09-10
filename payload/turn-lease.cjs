"use strict";

/**
 * Turn-idle lease.
 *
 * A bot-mode upgrade must not SIGTERM the host while the bot turn that started
 * the upgrade is still running, so reconcile defers the bounce and a
 * `finalize-host` pass applies it later. The only process that sees turn
 * boundaries is the hop: the host calls us on every model step, so an
 * in-flight counter plus the time of the last hop activity is a cheap and
 * accurate "is the host idle?" oracle.
 *
 * Writes are atomic (temp file + rename) and best-effort: a lease failure must
 * never touch the chat path. There is deliberately no write throttle — the
 * finalizer must see an in-flight request immediately, and one small rename
 * per request boundary is nothing next to the request log this file
 * accompanies.
 */

var fs = require("fs");
var path = require("path");

var LEASE_FILE_NAME = "openbot-turn-lease.json";

function leasePath() {
  if (process.env.OPENBOT_TURN_LEASE) return process.env.OPENBOT_TURN_LEASE;
  if (process.env.OPENBOT_SAND_DATA) return path.join(process.env.OPENBOT_SAND_DATA, LEASE_FILE_NAME);
  if (process.env.OPENBOT_PLAN) return path.join(path.dirname(process.env.OPENBOT_PLAN), LEASE_FILE_NAME);
  return "/home/box/sand-data/" + LEASE_FILE_NAME;
}

var state = {
  active: 0,
  lastStartAt: 0,
  lastEndAt: 0,
  lastFinishReason: undefined,
  updatedAt: 0,
};

// Seed the last activity from disk so a hop restart keeps the shape of the
// previous turn. `active` deliberately starts at 0: a fresh process has no
// in-flight request, and a lease left at active>0 by a killed hop would
// otherwise block the deferred bounce forever.
//
// A process that finds no lease writes one immediately. This is what gives a
// box upgrading from a release without lease support a usable idle oracle:
// the fresh UI (and the wrapped host) load this file, so the deferred bounce
// is never left with "no evidence" of idleness until someone happens to chat.
function seed() {
  var raw = null;
  try {
    raw = fs.readFileSync(leasePath(), "utf8");
  } catch (err) {
    raw = null;
  }
  if (raw === null) {
    flush(Date.now());
    return;
  }
  try {
    var parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      if (typeof parsed.lastFinishReason === "string") state.lastFinishReason = parsed.lastFinishReason;
      if (typeof parsed.lastEndAt === "number") state.lastEndAt = parsed.lastEndAt;
      if (typeof parsed.lastStartAt === "number") state.lastStartAt = parsed.lastStartAt;
    }
  } catch (err) {
    /* corrupt lease: start fresh */
  }
}
seed();

function flush(nowMs) {
  state.updatedAt = nowMs;
  try {
    var body =
      JSON.stringify({
        active: state.active,
        lastStartAt: state.lastStartAt,
        lastEndAt: state.lastEndAt,
        lastFinishReason: state.lastFinishReason,
        updatedAt: state.updatedAt,
      }) + "\n";
    var file = leasePath();
    var tmp = file + "." + String(process.pid) + ".tmp";
    fs.writeFileSync(tmp, body, "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    /* never throw into the chat path */
  }
}

/** One hop request started. Visible on disk before any upstream work. */
function beginTurn() {
  state.active += 1;
  var nowMs = Date.now();
  state.lastStartAt = nowMs;
  flush(nowMs);
}

/**
 * One hop request settled. `finishReason` is the model's finish_reason when
 * the response carried one; anything else clears it, so an unclassifiable
 * response falls back to the conservative quiet window instead of inheriting
 * an older "stop".
 */
function endTurn(finishReason) {
  if (state.active > 0) state.active -= 1;
  var nowMs = Date.now();
  state.lastEndAt = nowMs;
  state.lastFinishReason = typeof finishReason === "string" && finishReason ? finishReason : undefined;
  flush(nowMs);
}

/** Mark "no hop activity right now" without touching the counter. */
function touch() {
  flush(Date.now());
}

function snapshot() {
  return {
    active: state.active,
    lastStartAt: state.lastStartAt,
    lastEndAt: state.lastEndAt,
    lastFinishReason: state.lastFinishReason,
    updatedAt: state.updatedAt,
  };
}

exports.LEASE_FILE_NAME = LEASE_FILE_NAME;
exports.leasePath = leasePath;
exports.beginTurn = beginTurn;
exports.endTurn = endTurn;
exports.touch = touch;
exports.snapshot = snapshot;
