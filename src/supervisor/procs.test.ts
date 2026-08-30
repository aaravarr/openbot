import assert from "node:assert/strict";
import test from "node:test";
import { isHostMainArgv } from "./procs.ts";

const host = "/home/box/sand-host/host-main.cjs";

test("host pid matcher requires node plus the host path as argv", () => {
  assert.equal(isHostMainArgv("node /home/box/sand-host/host-main.cjs", host, 1, 88), true);
  assert.equal(
    isHostMainArgv("/usr/bin/node /home/box/sand-host/host-main.cjs --gateway-token x", host, 1, 88),
    true,
  );
});

test("host pid matcher ignores shells that only mention the path", () => {
  assert.equal(
    isHostMainArgv(
      "/bin/zsh -c node --experimental-strip-types src/ui/server.ts OPENBOT_HOST_MAIN=/home/box/sand-host/host-main.cjs",
      host,
      1,
      88,
    ),
    false,
  );
});

test("host pid matcher ignores the current process", () => {
  assert.equal(isHostMainArgv("node /home/box/sand-host/host-main.cjs", host, 88, 88), false);
});
