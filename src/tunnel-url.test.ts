import assert from "node:assert/strict";
import test from "node:test";
import { publicTunnelUrl } from "./tunnel-url.ts";

const HOST = "burns-assisted-raw-col.trycloudflare.com";

test("publicTunnelUrl keeps a full https URL", () => {
  assert.equal(publicTunnelUrl(`https://${HOST}`), `https://${HOST}`);
});

test("publicTunnelUrl keeps an http URL", () => {
  const href = publicTunnelUrl(`http://${HOST}`);
  assert.equal(href, `http://${HOST}`);
  assert.equal(href.startsWith("https://http://"), false);
});

test("publicTunnelUrl prefixes a bare host with https", () => {
  assert.equal(publicTunnelUrl(HOST), `https://${HOST}`);
});

test("publicTunnelUrl prefixes a schemeless host with a path", () => {
  assert.equal(publicTunnelUrl(`${HOST}/console`), `https://${HOST}/console`);
});

test("publicTunnelUrl collapses repeated https schemes", () => {
  assert.equal(publicTunnelUrl(`https://https://${HOST}`), `https://${HOST}`);
  assert.equal(publicTunnelUrl(`https://https://https://${HOST}`), `https://${HOST}`);
});

test("publicTunnelUrl does not produce https://http://", () => {
  const href = publicTunnelUrl(`https://http://${HOST}`);
  assert.equal(href.includes("https://http://"), false);
  assert.equal(href, `http://${HOST}`);
});

test("publicTunnelUrl trims surrounding whitespace", () => {
  assert.equal(publicTunnelUrl(`  https://${HOST}  `), `https://${HOST}`);
  assert.equal(publicTunnelUrl(`  ${HOST}  `), `https://${HOST}`);
  assert.equal(publicTunnelUrl(`  https://https://${HOST}  `), `https://${HOST}`);
});
