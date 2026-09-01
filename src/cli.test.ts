import assert from "node:assert/strict";
import test from "node:test";
import { loopbackExpose } from "./domain/types.ts";
import { exposeFromTunnelAnswer, resolveInstallExpose, TUNNEL_PROMPT } from "./cli.ts";

const loopback = loopbackExpose();
const cloudflare = { kind: "cloudflare-quick" as const };

test("tunnel prompt y enables Cloudflare; empty and no mean loopback", () => {
  assert.equal(exposeFromTunnelAnswer("y").kind, "cloudflare-quick");
  assert.equal(exposeFromTunnelAnswer("Yes").kind, "cloudflare-quick");
  assert.equal(exposeFromTunnelAnswer("").kind, "loopback");
  assert.equal(exposeFromTunnelAnswer("n").kind, "loopback");
  assert.equal(exposeFromTunnelAnswer(undefined).kind, "loopback");
});

test("tunnel prompt tells the operator what to type", () => {
  assert.match(TUNNEL_PROMPT, /Type y then press Enter/);
  assert.match(TUNNEL_PROMPT, /Press Enter {16}this Computer only/);
  assert.match(TUNNEL_PROMPT, /Use Cloudflare Tunnel\? \[y\/N\] /);
});

test("resolveInstallExpose prefers the flag over a saved tunnel", () => {
  assert.equal(
    resolveInstallExpose({
      specified: true,
      flagged: loopback,
      saved: cloudflare,
      savedPresent: true,
      asked: cloudflare,
    }).kind,
    "loopback",
  );
});

test("resolveInstallExpose keeps a saved tunnel on update", () => {
  assert.equal(
    resolveInstallExpose({
      specified: false,
      flagged: loopback,
      saved: cloudflare,
      savedPresent: true,
      asked: loopback,
    }).kind,
    "cloudflare-quick",
  );
});

test("resolveInstallExpose uses the prompt on first install", () => {
  assert.equal(
    resolveInstallExpose({
      specified: false,
      flagged: loopback,
      saved: loopback,
      savedPresent: false,
      asked: cloudflare,
    }).kind,
    "cloudflare-quick",
  );
});
