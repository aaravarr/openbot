import { useState } from "react";
import { ArrowRight, Check, ChevronLeft, Info, ShieldAlert, TriangleAlert } from "lucide-react";
import { ApiError, completeOpenAIOAuth, startOpenAIOAuth } from "../api/client";
import type { SaveResult } from "../api/types";
import { labelReasoning } from "../lib/format";
import { OPENCODE_ZEN_FREE_MODELS, PRESETS, type Preset } from "../lib/presets";
import { refusalKindLabel, refusalRemedy } from "../lib/refusal";
import { navigate } from "../lib/router";
import { useApp } from "../store";
import { Badge, Button, Notice } from "../components/ui";
import { Field, Input, PasswordInput } from "../components/fields";

function usedMessage(result: SaveResult): string {
  const model = result.models.find((m) => m.id === result.activeModelId);
  const base = model
    ? `Grok Bot will use ${model.slug}${model.activeReasoning && model.activeReasoning !== "default" ? ` (${labelReasoning(model.activeReasoning)})` : ""} on the next message.`
    : "Provider activated.";
  return result.wrapBytesChanged ? `${base} Grok Bot was restarted to apply the wrap.` : base;
}

export function Setup() {
  const { save } = useApp();
  const [step, setStep] = useState(1);
  const [presetId, setPresetId] = useState<string>("openai");
  const [name, setName] = useState("OpenAI");
  const [origin, setOrigin] = useState("https://api.openai.com/v1");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [oauthSession, setOauthSession] = useState<string | null>(null);
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState("");
  const [oauthConnected, setOauthConnected] = useState(false);
  const [credentialMode, setCredentialMode] = useState<"api-key" | "oauth">("api-key");

  const preset: Preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]!;

  const pickPreset = (p: Preset) => {
    setPresetId(p.id);
    setName(p.name);
    setOrigin(p.origin);
    setCredentialMode("api-key");
    setOauthConnected(false);
    setOauthSession(null);
    setOauthUrl(null);
    setCallbackUrl("");
    setRefusal(null);
  };

  const continueToCredentials = () => {
    setFieldError(null);
    setStep(2);
  };

  const continueToReview = () => {
    setFieldError(null);
    if (!name.trim()) {
      setFieldError("Name is required.");
      return;
    }
    if (!origin.trim()) {
      setFieldError("Base URL is required.");
      return;
    }
    if (credentialMode === "api-key" && !secret.trim()) {
      setFieldError("API key is required — the hop would fail with no key.");
      return;
    }
    if (credentialMode === "oauth" && !oauthConnected) {
      setFieldError("Complete OpenAI sign-in before continuing.");
      return;
    }
    setStep(3);
  };

  const beginOAuth = async () => {
    try {
      const result = await startOpenAIOAuth();
      setOauthSession(result.sessionId);
      setOauthUrl(result.authorizationUrl);
    } catch (err) {
      setFieldError(err instanceof Error ? err.message : "Could not start OpenAI sign-in.");
    }
  };

  const finishOAuth = async () => {
    if (!oauthSession || !callbackUrl.trim()) return;
    try {
      await completeOpenAIOAuth(oauthSession, callbackUrl.trim());
      setOauthConnected(true);
      setOauthSession(null);
      setOauthUrl(null);
      setCallbackUrl("");
      setFieldError(null);
    } catch (err) {
      setFieldError(err instanceof Error ? err.message : "OpenAI sign-in failed.");
    }
  };

  const activate = async () => {
    setBusy(true);
    setRefusal(null);
    try {
      await save(
        {
          kind: "upsert-provider",
          name: name.trim(),
          origin: origin.trim(),
          modelSlug: preset.id === "opencode" ? OPENCODE_ZEN_FREE_MODELS[0]?.id ?? preset.model : preset.model,
          secret: credentialMode === "oauth" && oauthConnected ? "oauth" : secret,
        },
        { successTitle: "Activated", successMessage: usedMessage },
      );
      navigate({ kind: "dashboard" });
    } catch (err) {
      if (err instanceof ApiError && err.refusal) {
        setRefusal(`${refusalKindLabel(err.refusal)} — ${refusalRemedy(err.refusal)}`);
      } else {
        setRefusal(err instanceof Error ? err.message : "Activation failed.");
      }
    } finally {
      setBusy(false);
    }
  };

  const StepIndicator = ({ n }: { n: number }) => (
    <div className="step__num">{n < step ? <Check aria-hidden="true" /> : n}</div>
  );

  return (
    <div className="wizard">
      <div className="page-title-row">
        <button className="icon-btn" aria-label="Back to Models" onClick={() => navigate({ kind: "models" })}>
          <ChevronLeft aria-hidden="true" />
        </button>
        <h1>Add a provider</h1>
      </div>

      <div className="steps">
        <div className={`step${step === 1 ? " is-current" : ""}${step > 1 ? " is-done" : ""}`}>
          <StepIndicator n={1} />
          Provider
        </div>
        <span className="step__sep" />
        <div className={`step${step === 2 ? " is-current" : ""}${step > 2 ? " is-done" : ""}`}>
          <StepIndicator n={2} />
          Credentials
        </div>
        <span className="step__sep" />
        <div className={`step${step === 3 ? " is-current" : ""}`}>
          <StepIndicator n={3} />
          Review &amp; activate
        </div>
      </div>

      {refusal ? (
        <div className="notice notice--danger" style={{ marginBottom: 16 }}>
          <ShieldAlert aria-hidden="true" />
          <span className="text">{refusal}</span>
        </div>
      ) : null}

      {step === 1 ? (
        <section>
          <div className="section-label" style={{ marginBottom: 10 }}>
            Pick a preset
          </div>
          <div className="preset-grid">
            {PRESETS.map((p) => (
              <button
                type="button"
                key={p.id}
                className={`preset${p.id === presetId ? " is-selected" : ""}`}
                onClick={() => pickPreset(p)}
                aria-pressed={p.id === presetId}
              >
                <span className="preset__name">
                  {p.name}
                  {p.id === "opencode" ? <Badge tone="success">Free</Badge> : null}
                </span>
                <span className="preset__origin">{p.origin || "your-endpoint.example"}</span>
              </button>
            ))}
          </div>
          <div className="preset__hint">{preset.hint}</div>
          <div className="row wrap" style={{ justifyContent: "flex-end", marginTop: 20 }}>
            <Button variant="primary" onClick={continueToCredentials}>
              Continue <ArrowRight aria-hidden="true" />
            </Button>
          </div>
        </section>
      ) : null}

      {step === 2 ? (
        <section>
          <div className="card card--pad" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <Field label="Name" htmlFor="f-name">
              <Input id="f-name" large value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Base URL" htmlFor="f-origin">
              <Input id="f-origin" large mono value={origin} onChange={(e) => setOrigin(e.target.value)} />
            </Field>
            {preset.oauth ? (
              <div className="credential-tabs" role="tablist" aria-label="OpenAI credential type">
                <button type="button" role="tab" aria-selected={credentialMode === "api-key"} className={credentialMode === "api-key" ? "is-active" : ""} onClick={() => { setCredentialMode("api-key"); setFieldError(null); }}>API Key</button>
                <button type="button" role="tab" aria-selected={credentialMode === "oauth"} className={credentialMode === "oauth" ? "is-active" : ""} onClick={() => { setCredentialMode("oauth"); setFieldError(null); }}>Sign in with OpenAI</button>
              </div>
            ) : null}
            {credentialMode === "api-key" || !preset.oauth ? (
              <Field label="API key" htmlFor="f-key" helper="Stored locally (0600), never displayed again, never in a URL.">
                <PasswordInput id="f-key" large value={secret} onChange={setSecret} placeholder="Paste your key" />
              </Field>
            ) : (
              <div className="card card--pad oauth-panel" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <p className="card__hint">Use your OpenAI account to connect ChatGPT/Codex models.</p>
                {!oauthConnected ? <Button variant="secondary" onClick={() => void beginOAuth()}>Start OpenAI sign-in</Button> : <Notice tone="info" icon={Check}>OpenAI account connected.</Notice>}
                {oauthUrl ? <a href={oauthUrl} target="_blank" rel="noreferrer">Open the OpenAI authorization page</a> : null}
                {oauthSession ? <>
                  <Field label="Authorization callback URL" htmlFor="oauth-callback" helper="Paste the complete localhost:1455 URL after authorization.">
                    <Input id="oauth-callback" mono value={callbackUrl} onChange={(e) => setCallbackUrl(e.target.value)} placeholder="http://localhost:1455/auth/callback?..." />
                  </Field>
                  <Button variant="secondary" onClick={() => void finishOAuth()}>Complete OpenAI sign-in</Button>
                </> : null}
              </div>
            )}
            {fieldError ? (
              <Notice tone="warn" icon={TriangleAlert}>
                {fieldError}
              </Notice>
            ) : null}
          </div>
          <div className="row wrap" style={{ justifyContent: "space-between", marginTop: 20 }}>
            <Button variant="ghost" onClick={() => setStep(1)}>
              <ChevronLeft aria-hidden="true" />
              Back
            </Button>
            <Button variant="primary" onClick={continueToReview}>
              Review <ArrowRight aria-hidden="true" />
            </Button>
          </div>
        </section>
      ) : null}

      {step === 3 ? (
        <section>
          <div className="card card--pad" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="def-grid">
              <span className="k">Provider</span>
              <span className="v">{name}</span>
              <span className="k">Base URL</span>
              <span className="v mono">{origin}</span>
              <span className="k">Model</span>
              <span className="v mono">— (none)</span>
              <span className="k">API key</span>
              <span className="v mono">{credentialMode === "oauth" ? "OpenAI OAuth (saved on activate)" : "•••••••• (saved on activate)"}</span>
            </div>
            <Notice tone="info" icon={Info}>
              <span>No model yet — you can fetch models from the Models page after activation.</span>
            </Notice>
            <div className="row wrap" style={{ justifyContent: "space-between", alignItems: "center" }}>
              <Button variant="ghost" onClick={() => setStep(2)}>
                <ChevronLeft aria-hidden="true" />
                Back
              </Button>
              <Button variant="primary-lg" loading={busy} loadingLabel="Activating…" onClick={activate}>
                Wrap host and activate
              </Button>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
