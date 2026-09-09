import assert from "node:assert/strict";
import test from "node:test";
import { completeOpenAIOAuth, parseCallbackUrl, startOpenAIOAuth, resetOpenAIOAuthForTests, OPENAI_OAUTH_TOKEN_URL } from "./openai-oauth.ts";

test("OpenAI OAuth creates an S256 PKCE authorization URL", () => {
  resetOpenAIOAuthForTests();
  const started = startOpenAIOAuth();
  const url = new URL(started.authorizationUrl);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.ok(url.searchParams.get("code_challenge"));
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.ok(started.sessionId);
});

test("OpenAI OAuth exchanges a callback code with a mock fetch", async () => {
  resetOpenAIOAuthForTests();
  const started = startOpenAIOAuth();
  const auth = new URL(started.authorizationUrl);
  const callback = "http://localhost:1455/auth/callback?code=test-code&state=" + encodeURIComponent(auth.searchParams.get("state")!);
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const credential = await completeOpenAIOAuth(started.sessionId, callback, async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200 });
  });
  assert.equal(calls[0]?.url, OPENAI_OAUTH_TOKEN_URL);
  assert.match(String(calls[0]?.init?.body), /grant_type=authorization_code/);
  assert.equal(credential.kind, "openai-oauth");
  assert.equal(credential.accessToken, "at");
  assert.equal(credential.refreshToken, "rt");
});

test("OpenAI OAuth rejects a callback from the wrong host", () => {
  assert.throws(() => parseCallbackUrl("https://example.com/callback?code=x&state=y"), /Callback URL/);
});
