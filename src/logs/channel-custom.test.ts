import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
const log = require("../../payload/request-log.cjs") as {
  saveSettings: (input: unknown) => Record<string, unknown>;
  recordHop: (input: unknown) => void;
  listRequests: (query?: unknown) => { items: Array<{ channel?: string; model?: string }>; total: number };
};

function withSand<T>(fn: () => T): T {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openbot-logs-ch-"));
  const prevSand = process.env.OPENBOT_SAND_DATA;
  const prevLogs = process.env.OPENBOT_LOGS;
  const prevSecrets = process.env.OPENBOT_SECRETS;
  process.env.OPENBOT_SAND_DATA = dir;
  delete process.env.OPENBOT_LOGS;
  process.env.OPENBOT_SECRETS = path.join(dir, "secrets.json");
  try {
    return fn();
  } finally {
    if (prevSand === undefined) delete process.env.OPENBOT_SAND_DATA;
    else process.env.OPENBOT_SAND_DATA = prevSand;
    if (prevLogs === undefined) delete process.env.OPENBOT_LOGS;
    else process.env.OPENBOT_LOGS = prevLogs;
    if (prevSecrets === undefined) delete process.env.OPENBOT_SECRETS;
    else process.env.OPENBOT_SECRETS = prevSecrets;
  }
}

test("channel custom includes hop and custom-host layers of one turn", () => {
  withSand(() => {
    log.saveSettings({ loggingEnabled: true, logBodies: true });
    log.recordHop({
      id: "req-official-02",
      channel: "official",
      inboundEndpoint: "host-stream",
      status: 200,
      model: "grok-4.5",
    });
    log.recordHop({
      id: "req-hop-02",
      channel: "hop",
      inboundEndpoint: "/v1/chat/completions",
      status: 200,
      model: "glm-5.3-flash",
    });
    log.recordHop({
      id: "req-host-02",
      channel: "custom-host",
      inboundEndpoint: "host-stream",
      status: 200,
      model: "glm-5.3-flash",
    });
    assert.equal(log.listRequests({ channel: "official" }).total, 1);
    const custom = log.listRequests({ channel: "custom" });
    assert.equal(custom.total, 2);
    const channels = custom.items.map((row) => row.channel).sort();
    assert.deepEqual(channels, ["custom-host", "hop"]);
  });
});
