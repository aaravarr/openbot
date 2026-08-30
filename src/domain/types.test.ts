import assert from "node:assert/strict";
import test from "node:test";
import {
  HIGH_AGENT_MAX_TOKENS,
  LOOPBACK,
  LOOPBACK_HOP,
  OPENBOT_MARKER,
  UI_PORT,
  align,
  hopBaseUrl,
  type CustomBox,
  type OfficialBox,
} from "./types.ts";
import { parseAbsPath } from "../supervisor/paths.ts";

const secretsPath = parseAbsPath("/home/box/sand-data/secrets.json");

test("hopBaseUrl is derived from loopback, not stored on Binding", () => {
  assert.equal(hopBaseUrl(LOOPBACK_HOP), "http://127.0.0.1:18790/v1");
});

test("HIGH_AGENT_MAX_TOKENS is not 8192", () => {
  assert.equal(HIGH_AGENT_MAX_TOKENS, 65536);
});

test("align names needs-reinstall when custom is desired and wrap is stock", () => {
  const desired: CustomBox = {
    kind: "custom",
    wrap: { kind: "marked", marker: OPENBOT_MARKER },
    hopListen: { kind: "adopt-or-start", host: LOOPBACK, port: 18790 },
    uiListen: { kind: "loopback", host: LOOPBACK, port: UI_PORT },
    secretsPath,
    hop: LOOPBACK_HOP,
    catalog: { providers: [], models: [], bindings: [] },
  };
  const a = align(desired, { kind: "stock-unmarked" });
  assert.equal(a.kind, "needs-reinstall");
});

test("align is ok when official is desired and wrap is stock", () => {
  const desired: OfficialBox = {
    kind: "official",
    wrap: { kind: "stock" },
    hopListen: { kind: "stop-owned" },
    uiListen: { kind: "loopback", host: LOOPBACK, port: UI_PORT },
    secretsPath,
  };
  const a = align(desired, { kind: "stock-unmarked" });
  assert.equal(a.kind, "ok");
});

test("official box has no catalog and no hop", () => {
  const official: OfficialBox = {
    kind: "official",
    wrap: { kind: "stock" },
    hopListen: { kind: "stop-owned" },
    uiListen: { kind: "loopback", host: LOOPBACK, port: UI_PORT },
    secretsPath,
  };
  assert.equal(official.kind, "official");
  assert.equal("catalog" in official ? official.catalog : undefined, undefined);
  assert.equal("hop" in official ? official.hop : undefined, undefined);
});
