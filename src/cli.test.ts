import assert from "node:assert/strict";
import test from "node:test";
import { exposeFromTunnelAnswer, TUNNEL_PROMPT } from "./cli.ts";

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
