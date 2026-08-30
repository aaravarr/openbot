import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { OPENBOT_MARKER } from "./domain/types.ts";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const installSh = path.join(repoRoot, "install.sh");

const STOCK = `function createProtoSessionProvider(client) {
  return { getSession: function () { return 1; } };
}
`;

function killPidFile(file: string): void {
  try {
    const pid = Number(readFileSync(file, "utf8").trim());
    if (Number.isInteger(pid) && pid > 0) {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    /* already gone */
  }
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", reject);
  });
}

test("install.sh refuses a machine without the Computer host file", () => {
  const result = spawnSync("bash", [installSh], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENBOT_HOST_MAIN: "/tmp/openbot-missing-host-main.cjs",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Grok Bot Computer/);
  assert.match(result.stderr, /Missing \/tmp\/openbot-missing-host-main\.cjs/);
});

test("install.sh copies the tree, leaves the host stock, and starts the UI", async () => {
  const box = mkdtempSync(path.join(os.tmpdir(), "openbot-install-box-"));
  const src = mkdtempSync(path.join(os.tmpdir(), "openbot-install-src-"));
  const hostMain = path.join(box, "sand-host", "host-main.cjs");
  const sandData = path.join(box, "sand-data");
  mkdirSync(path.join(box, "sand-host"));
  mkdirSync(sandData);
  writeFileSync(hostMain, STOCK);
  for (const name of ["src", "ui", "payload", "package.json"]) {
    cpSync(path.join(repoRoot, name), path.join(src, name), { recursive: true });
  }

  const result = spawnSync("bash", [installSh], {
    encoding: "utf8",
    timeout: 30000,
    env: {
      ...process.env,
      OPENBOT_HOST_MAIN: hostMain,
      OPENBOT_SAND_DATA: sandData,
      OPENBOT_SRC: src,
      OPENBOT_DEST: path.join(sandData, "openbot"),
    },
  });

  try {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /OpenBot UI: http:\/\/127\.0\.0\.1:18791/);
    assert.equal(readFileSync(hostMain, "utf8").includes(OPENBOT_MARKER), false);
    assert.equal(readFileSync(hostMain, "utf8").includes("function createProtoSessionProvider(client)"), true);
    const html = await get("http://127.0.0.1:18791/");
    assert.equal(html.status, 200);
    assert.match(html.body, /Save and use/);
    const css = await get("http://127.0.0.1:18791/styles.css");
    assert.equal(css.status, 200);
    assert.match(css.body, /#f7f7f4/);
    assert.match(css.body, /#f54e00/);
    assert.equal(css.body.includes("box-shadow"), false);
    const state = await get("http://127.0.0.1:18791/api/state");
    assert.equal(state.status, 200);
    const parsed = JSON.parse(state.body) as {
      snapshot: { wrap: { kind: string }; uiListen: { kind: string }; hopListen: { kind: string } };
    };
    assert.equal(parsed.snapshot.wrap.kind, "stock-unmarked");
    assert.equal(parsed.snapshot.uiListen.kind, "ours");
    assert.equal(parsed.snapshot.hopListen.kind, "absent");
  } finally {
    killPidFile(path.join(sandData, "openbot-ui.pid"));
    killPidFile(path.join(sandData, "openbot-hop.pid"));
  }
});
