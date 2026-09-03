import assert from "node:assert/strict";
import test from "node:test";
import {
  buildReasoningAllowList,
  fetchedReasoningLevels,
  LEGACY_CATALOG_REASONING,
  mapVendorEffort,
  parseStoredReasoningLevels,
  resolveImportReasoningLevels,
  unionReasoningLevels,
  vendorReasoningFacts,
} from "./reasoning-efforts.ts";

test("mapVendorEffort maps vendor tokens onto the OpenBot universe", () => {
  assert.equal(mapVendorEffort("default"), "default");
  assert.equal(mapVendorEffort("none"), "none");
  assert.equal(mapVendorEffort("off"), "none");
  assert.equal(mapVendorEffort("disabled"), "none");
  assert.equal(mapVendorEffort("low"), "low");
  assert.equal(mapVendorEffort("minimal"), "low");
  assert.equal(mapVendorEffort("min"), "low");
  assert.equal(mapVendorEffort("medium"), "medium");
  assert.equal(mapVendorEffort("med"), "medium");
  assert.equal(mapVendorEffort("high"), "high");
  assert.equal(mapVendorEffort("max"), "max");
  assert.equal(mapVendorEffort("xhigh"), "xhigh");
  assert.equal(mapVendorEffort("x-high"), "xhigh");
  assert.equal(mapVendorEffort("extra-high"), "xhigh");
  assert.equal(mapVendorEffort("extra_high"), "xhigh");
  assert.equal(mapVendorEffort("MAX"), "max");
  assert.equal(mapVendorEffort("bogus"), undefined);
  assert.equal(mapVendorEffort(""), undefined);
  assert.equal(mapVendorEffort(1), undefined);
});

test("mapVendorEffort does not collapse max and xhigh", () => {
  assert.equal(mapVendorEffort("max"), "max");
  assert.equal(mapVendorEffort("xhigh"), "xhigh");
  assert.notEqual(mapVendorEffort("max"), mapVendorEffort("xhigh"));
});

test("buildReasoningAllowList keeps default only when reasoning is absent", () => {
  assert.deepEqual(
    buildReasoningAllowList({ reasoning: false, mandatory: false, hasToggle: false, effortTokens: [] }),
    ["default"],
  );
  assert.deepEqual(
    buildReasoningAllowList({ reasoning: undefined, mandatory: false, hasToggle: false, effortTokens: [] }),
    ["default"],
  );
});

test("buildReasoningAllowList uses the legacy fallback when reasoning is on with no list", () => {
  assert.deepEqual(
    buildReasoningAllowList({ reasoning: true, mandatory: false, hasToggle: false, effortTokens: [] }),
    LEGACY_CATALOG_REASONING,
  );
  assert.deepEqual(
    buildReasoningAllowList(
      { reasoning: undefined, mandatory: false, hasToggle: false, effortTokens: [] },
      true,
    ),
    LEGACY_CATALOG_REASONING,
  );
});

test("buildReasoningAllowList drops none when reasoning is mandatory", () => {
  assert.deepEqual(
    buildReasoningAllowList({
      reasoning: true,
      mandatory: true,
      hasToggle: false,
      effortTokens: ["max", "high", "low"],
    }),
    ["default", "low", "high", "max"],
  );
});

test("buildReasoningAllowList keeps none for optional efforts, toggle, or optional reasoning", () => {
  assert.deepEqual(
    buildReasoningAllowList({
      reasoning: true,
      mandatory: false,
      hasToggle: false,
      effortTokens: ["xhigh", "high"],
    }),
    ["default", "none", "high", "xhigh"],
  );
  assert.deepEqual(
    buildReasoningAllowList({
      reasoning: true,
      mandatory: false,
      hasToggle: true,
      effortTokens: ["low", "high", "max"],
    }),
    ["default", "none", "low", "high", "max"],
  );
});

test("buildReasoningAllowList does not invent max or xhigh", () => {
  assert.deepEqual(
    buildReasoningAllowList({ reasoning: true, mandatory: false, hasToggle: false, effortTokens: [] }),
    ["default", "none", "high"],
  );
  assert.ok(
    !buildReasoningAllowList({
      reasoning: true,
      mandatory: false,
      hasToggle: false,
      effortTokens: ["low", "high"],
    }).includes("max"),
  );
});

test("vendorReasoningFacts reads OpenRouter supported_efforts and models.dev options", () => {
  const openrouter = vendorReasoningFacts({
    reasoning: { mandatory: true, supported_efforts: ["max", "high", "low"] },
  });
  assert.equal(openrouter.mandatory, true);
  assert.deepEqual(openrouter.effortTokens, ["max", "high", "low"]);

  const modelsDev = vendorReasoningFacts({
    reasoning: true,
    reasoning_options: [
      { type: "toggle" },
      { type: "effort", values: ["low", "high", "max"] },
    ],
  });
  assert.equal(modelsDev.reasoning, true);
  assert.equal(modelsDev.hasToggle, true);
  assert.deepEqual(modelsDev.effortTokens, ["low", "high", "max"]);
});

test("parseStoredReasoningLevels keeps old caches boolean-only", () => {
  assert.deepEqual(parseStoredReasoningLevels(undefined), []);
  assert.deepEqual(parseStoredReasoningLevels([]), []);
  assert.deepEqual(parseStoredReasoningLevels(["low", "max", "bogus"]), ["default", "low", "max"]);
});

test("unionReasoningLevels does not let an empty husk erase a rich list", () => {
  assert.deepEqual(unionReasoningLevels(["default", "low", "high", "max"], []), ["default", "low", "high", "max"]);
  assert.deepEqual(unionReasoningLevels([], ["default", "none", "xhigh"]), ["default", "none", "xhigh"]);
  assert.deepEqual(
    unionReasoningLevels(["default", "max"], ["default", "none", "xhigh"]),
    ["default", "none", "max", "xhigh"],
  );
});

test("fetchedReasoningLevels is empty without a vendor signal", () => {
  assert.deepEqual(fetchedReasoningLevels({ id: "plain" }), []);
  assert.deepEqual(
    fetchedReasoningLevels({
      reasoning: { mandatory: false, supported_efforts: ["xhigh", "high"] },
    }),
    ["default", "none", "high", "xhigh"],
  );
  assert.deepEqual(
    fetchedReasoningLevels({
      reasoning_options: [
        { type: "toggle" },
        { type: "effort", values: ["low", "high", "max"] },
      ],
    }),
    ["default", "none", "low", "high", "max"],
  );
});

test("resolveImportReasoningLevels prefers catalog efforts over a boolean-only fallback", () => {
  assert.deepEqual(
    resolveImportReasoningLevels({
      catalogLevels: ["default", "low", "high", "max"],
      catalogReasoning: true,
      fetchedLevels: ["default", "none", "high"],
    }),
    ["default", "low", "high", "max"],
  );
  assert.deepEqual(
    resolveImportReasoningLevels({
      catalogLevels: [],
      catalogReasoning: true,
      fetchedLevels: ["default", "none", "max"],
    }),
    ["default", "none", "max"],
  );
  assert.deepEqual(
    resolveImportReasoningLevels({ catalogLevels: [], catalogReasoning: false, fetchedLevels: [] }),
    ["default"],
  );
  assert.deepEqual(
    resolveImportReasoningLevels({ catalogLevels: [], catalogReasoning: true, fetchedLevels: [] }),
    LEGACY_CATALOG_REASONING,
  );
  assert.equal(resolveImportReasoningLevels({ fetchedLevels: [] }), undefined);
});
