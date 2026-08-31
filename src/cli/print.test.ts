import assert from "node:assert/strict";
import test from "node:test";
import { type OwnedPid, type Snapshot } from "../domain/types.ts";
import { printReady, printStatus } from "./print.ts";

function officialSnapshot(tunnel: Snapshot["tunnel"]): Snapshot {
  return {
    wrap: { kind: "stock-unmarked" },
    hopListen: { kind: "absent" },
    uiListen: { kind: "absent" },
    host: { kind: "absent" },
    alignment: { kind: "ok", desired: "official", wrap: "stock-unmarked" },
    tunnel,
  };
}

function captureLog(run: () => void): string {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    run();
  } finally {
    console.log = orig;
  }
  return lines.join("\n");
}

test("tunnel ready text prints the QR before Computer and Phone URLs", () => {
  const url = "https://openbot-test.trycloudflare.com";
  const out = captureLog(() => {
    printReady(
      officialSnapshot({
        kind: "cloudflare-quick",
        url,
        internal: "http://127.0.0.1:9280",
        pid: 1 as OwnedPid,
      }),
    );
  });
  const scan = out.indexOf("Scan from your phone:");
  const qr = out.search(/[█▀▄]/u);
  const computer = out.indexOf("This Computer");
  const phone = out.indexOf("Phone");
  const phoneUrl = out.indexOf(url);
  assert.ok(scan >= 0);
  assert.ok(qr >= 0);
  assert.ok(computer >= 0);
  assert.ok(phone >= 0);
  assert.ok(phoneUrl >= 0);
  assert.ok(scan < qr);
  assert.ok(qr < computer);
  assert.ok(computer < phone);
  assert.ok(phone < phoneUrl);
});

test("loopback ready text has no QR and still prints This Computer", () => {
  const out = captureLog(() => {
    printReady(officialSnapshot({ kind: "off" }));
  });
  assert.match(out, /This Computer/);
  assert.match(out, /http:\/\/127\.0\.0\.1:9280/);
  assert.equal(out.includes("Scan from your phone:"), false);
  assert.equal(/[█▀▄]/u.test(out), false);
});

test("status with a tunnel also prints URLs after the QR", () => {
  const url = "https://openbot-test.trycloudflare.com";
  const out = captureLog(() => {
    printStatus(
      officialSnapshot({
        kind: "cloudflare-quick",
        url,
        internal: "http://127.0.0.1:9280",
        pid: 1 as OwnedPid,
      }),
      false,
    );
  });
  assert.match(out, /^Chat: official Grok/u);
  const qr = out.search(/[█▀▄]/u);
  const computer = out.indexOf("This Computer");
  assert.ok(qr >= 0);
  assert.ok(qr < computer);
});
