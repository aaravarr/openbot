import assert from "node:assert/strict";
import test from "node:test";
import { computePauseIds, computeResumeIds } from "../../web/src/lib/batch-pause.ts";

test("batch pause unions the latest paused list with the selection", () => {
  assert.deepEqual(computePauseIds(["b", "a"], ["c", "a"]), ["a", "b", "c"]);
  assert.deepEqual(computePauseIds([], ["z"]), ["z"]);
  assert.deepEqual(computePauseIds(["b", "b"], ["b", "a", "a"]), ["a", "b"]);
  assert.deepEqual(computePauseIds(["b", "a"], []), ["a", "b"]);
});

test("batch resume removes only selected ids and keeps concurrent pauses", () => {
  assert.deepEqual(computeResumeIds(["a", "b", "c"], ["b"]), ["a", "c"]);
  assert.deepEqual(computeResumeIds(["a"], ["x"]), ["a"]);
  assert.deepEqual(computeResumeIds([], ["a"]), []);
  assert.deepEqual(computeResumeIds(["a", "a", "b"], ["a", "a"]), ["b"]);
  assert.deepEqual(computeResumeIds(["a", "b"], []), ["a", "b"]);
});
