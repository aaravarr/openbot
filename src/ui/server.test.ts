import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import test from "node:test";

// Force Unix-style box paths so the supervisor's parseAbsPath accepts them on
// every platform (Windows resolves a leading slash against the current drive).
process.env.OPENBOT_REPO = "/tmp/openbot-repo";
process.env.OPENBOT_SAND_DATA = "/tmp/openbot-sand-data";
process.env.OPENBOT_HOST_MAIN = "/tmp/openbot-sand-host/host-main.cjs";

const { handleRequest } = await import("./server.ts");

function listen(): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      void handleRequest(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        throw new Error("no port");
      }
      resolve({ server, port: addr.port });
    });
  });
}

function request(
  port: number,
  pathname: string,
  method: string,
  body?: Buffer,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const options: http.RequestOptions = {
      host: "127.0.0.1",
      port,
      path: pathname,
      method,
    };
    if (body) {
      options.headers = { "Content-Type": "application/json", "Content-Length": String(body.length) };
    }
    const req = http.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, json: JSON.parse(raw) as unknown });
      });
    });
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

test("a throwing handler returns a structured 500 and the server keeps serving", async () => {
  const { server, port } = await listen();
  try {
    // "bogus" is not a valid UI command, so parseUiCommand throws inside the
    // /api/save handler and must surface as a structured 500, not a crash.
    const bad = await request(port, "/api/save", "POST", Buffer.from(JSON.stringify({ kind: "bogus" })));
    assert.equal(bad.status, 500);
    const body = bad.json as { error: { kind: string; message: string } };
    assert.equal(body.error.kind, "internal");
    assert.match(body.error.message, /unknown UI command/);

    // The process survives the handler throw and keeps answering requests.
    const alive = await request(port, "/api/state", "GET");
    assert.equal(alive.status, 200);
  } finally {
    server.close();
    server.closeAllConnections();
  }
});

test("process guards keep the process alive on an unhandled rejection", () => {
  // Run in a child process: in the test runner's own process an unhandled
  // rejection is reported as a test failure, so proving "not fatal" needs the
  // real exit semantics of a standalone node process.
  const serverUrl = new URL("./server.ts", import.meta.url).href;
  const script = [
    `import(${JSON.stringify(serverUrl)}).then(({ registerProcessFallbacks }) => {`,
    `  let logged = false;`,
    `  registerProcessFallbacks((line) => {`,
    `    if (line.includes("unhandled rejection") && line.includes("openbot-child-boom")) logged = true;`,
    `  });`,
    `  void Promise.reject(new Error("openbot-child-boom"));`,
    `  setTimeout(() => {`,
    `    if (logged) { process.stdout.write("survived\\n"); process.exit(0); }`,
    `    process.exit(2);`,
    `  }, 150);`,
    `}).catch((err) => { process.stderr.write(String(err && err.stack ? err.stack : err)); process.exit(3); });`,
  ].join("\n");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--eval", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENBOT_REPO: "/tmp/openbot-repo",
      OPENBOT_SAND_DATA: "/tmp/openbot-sand-data",
      OPENBOT_HOST_MAIN: "/tmp/openbot-sand-host/host-main.cjs",
    },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /survived/);
});
