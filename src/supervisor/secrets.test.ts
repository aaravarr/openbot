import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderId, parseSecretBytes, readSecretStore, upsertSecret, writeSecretStore } from "./secrets.ts";

test("secret store round-trips a provider key without extra fields", () => {
  const store = upsertSecret({ providers: {} }, parseProviderId("zhipu"), parseSecretBytes("sk-live"));
  const raw = writeSecretStore(store);
  assert.equal(raw.includes("apiKey"), false);
  const again = readSecretStore(raw);
  assert.equal(again.providers.zhipu, "sk-live");
});
