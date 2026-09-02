"use strict";

var fs = require("fs");
var path = require("path");
var { execFileSync } = require("child_process");

var HEADER = "x-openbot-version";
var stamped;

function readStampedCommit() {
  try {
    var raw = fs.readFileSync(path.join(__dirname, "version.json"), "utf8");
    var row = JSON.parse(raw);
    if (row && typeof row.commit === "string" && row.commit.trim()) {
      return row.commit.trim();
    }
  } catch (err) {
    /* missing stamp is fine */
  }
  return "";
}

function readGitCommit() {
  try {
    var out = execFileSync(
      "git",
      ["-C", path.join(__dirname, ".."), "rev-parse", "HEAD"],
      { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] },
    );
    var sha = String(out || "").trim();
    if (/^[0-9a-f]{7,40}$/i.test(sha)) return sha;
  } catch (err) {
    /* tarball installs have no git */
  }
  return "";
}

function openBotVersion() {
  var fromEnv = process.env.OPENBOT_COMMIT;
  if (typeof fromEnv === "string" && fromEnv.trim()) {
    return fromEnv.trim();
  }
  if (stamped === undefined) {
    stamped = readStampedCommit() || readGitCommit() || "unknown";
  }
  return stamped;
}

function openBotUserAgent() {
  return "openbot/" + openBotVersion();
}

function applyOpenBotVersionHeader(headers) {
  if (!headers || typeof headers !== "object") return headers;
  var version = openBotVersion();
  headers[HEADER] = version;
  if (!headers["User-Agent"] && !headers["user-agent"]) {
    headers["User-Agent"] = "openbot/" + version;
  }
  return headers;
}

exports.HEADER = HEADER;
exports.openBotVersion = openBotVersion;
exports.openBotUserAgent = openBotUserAgent;
exports.applyOpenBotVersionHeader = applyOpenBotVersionHeader;
