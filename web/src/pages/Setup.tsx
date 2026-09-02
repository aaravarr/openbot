import { useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronLeft,
  Download,
  Info,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { ApiError, fetchProviderModels } from "../api/client";
import type {
  CatalogLookupModel,
  FetchModelsError,
  FetchModelsResult,
  FetchedModel,
  SaveResult,
} from "../api/types";
import { labelReasoning } from "../lib/format";
import { enrichCatalogModels, modelImportFields } from "../lib/import-models";
import { PRESETS, type Preset } from "../lib/presets";
import { refusalKindLabel, refusalRemedy } from "../lib/refusal";
import { navigate } from "../lib/router";
import { useApp } from "../store";
import { Button, Notice } from "../components/ui";
import { Field, Input, PasswordInput } from "../components/fields";
import { ImportModelsDialog } from "../components/ImportModelsDialog";

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
  const [presetId, setPresetId] = useState<string>("zhipu");
  const [name, setName] = useState("Zhipu GLM");
  const [origin, setOrigin] = useState("https://open.bigmodel.cn/api/paas/v4");
  const [modelSlug, setModelSlug] = useState("glm-5.3");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  // Fetch-in-wizard state (Source A → Import models dialog).
  const [savedProviderId, setSavedProviderId] = useState<string | null>(null);
  const [importedModels, setImportedModels] = useState<FetchedModel[]>([]);
  const [fetching, setFetching] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [fetchResult, setFetchResult] = useState<FetchModelsResult | null>(null);
  const [fetchError, setFetchError] = useState<FetchModelsError | null>(null);
  const [catalogMatched, setCatalogMatched] = useState<Set<string>>(new Set());
  const [catalogLookup, setCatalogLookup] = useState<Map<string, CatalogLookupModel>>(new Map());

  const preset: Preset = PRESETS.find((p) => p.id === presetId) ?? PRESETS[0]!;

  const pickPreset = (p: Preset) => {
    setPresetId(p.id);
    setName(p.name);
    setOrigin(p.origin);
    setModelSlug(p.model);
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
    if (!secret.trim()) {
      setFieldError("API key is required — the hop would fail with no key.");
      return;
    }
    setStep(3);
  };

  const saveAndFetch = async () => {
    setFieldError(null);
    setRefusal(null);
    if (!name.trim()) {
      setFieldError("Name is required.");
      return;
    }
    if (!origin.trim()) {
      setFieldError("Base URL is required.");
      return;
    }
    if (!secret.trim()) {
      setFieldError("API key is required — the hop would fail with no key.");
      return;
    }
    setFetching(true);
    try {
      const saved = await save(
        {
          kind: "upsert-provider",
          name: name.trim(),
          origin: origin.trim(),
          modelSlug: modelSlug.trim(),
          secret,
        },
        { successTitle: "Provider saved", successMessage: "Key stored — fetching its model list." },
      );
      const provider = saved.providers.find((p) => p.name === name.trim());
      if (!provider) {
        setFieldError("Saved provider not found — try again.");
        return;
      }
      setSavedProviderId(provider.id);
      setFetchResult(null);
      setFetchError(null);
      try {
        const result = await fetchProviderModels(provider.id);
        setFetchResult(result);
        void enrichCatalogModels(result.models).then(({ matched, lookup }) => {
          setCatalogMatched(matched);
          setCatalogLookup(lookup);
        });
      } catch (err) {
        const e = err instanceof ApiError ? err : new ApiError("Could not fetch models", { status: 500, fetchKind: "internal" });
        setFetchError({ error: { kind: e.fetchKind ?? "internal", message: e.message, upstreamStatus: e.upstreamStatus } });
      }
      setImportOpen(true);
    } catch (err) {
      if (err instanceof ApiError && err.refusal) {
        setRefusal(`${refusalKindLabel(err.refusal)} — ${refusalRemedy(err.refusal)}`);
      } else {
        setFieldError(err instanceof Error ? err.message : "Save failed.");
      }
    } finally {
      setFetching(false);
    }
  };

  const importChosen = async (chosen: FetchedModel[]) => {
    if (!savedProviderId) return;
    const added: FetchedModel[] = [];
    for (const m of chosen) {
      try {
        await save(
          { kind: "upsert-model", providerId: savedProviderId, ...modelImportFields(m, catalogLookup.get(m.id)) },
          { successTitle: "Model imported", successMessage: `${m.id} added to ${name.trim()}.` },
        );
        added.push(m);
      } catch {
        // The store already surfaced the error toast; stop importing the rest.
        break;
      }
    }
    if (added.length) {
      setImportedModels((prev) => {
        const seen = new Set(prev.map((x) => x.id));
        return [...prev, ...added.filter((m) => !seen.has(m.id))];
      });
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
          modelSlug: modelSlug.trim(),
          secret,
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

  const modelSummary = modelSlug.trim() || importedModels.map((m) => m.id).join(", ");
  const firstModel = modelSlug.trim() || importedModels[0]?.id || "";

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
          Credentials &amp; model
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
                <span className="preset__name">{p.name}</span>
                <span className="preset__origin">{p.origin || "your-endpoint.example"}</span>
              </button>
            ))}
          </div>
          <div className="preset__hint">{preset.hint}</div>
          <div className="row" style={{ justifyContent: "flex-end", marginTop: 20 }}>
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
            <Field label="Model id" htmlFor="f-model">
              <Input
                id="f-model"
                large
                mono
                value={modelSlug}
                onChange={(e) => setModelSlug(e.target.value)}
                placeholder="Optional — leave empty to fetch or add later"
              />
              <div className="row row--between" style={{ marginTop: 4 }}>
                <span className="helper">Optional — or save &amp; fetch the provider's list instead of typing.</span>
                <Button
                  variant="secondary-sm"
                  icon={Download}
                  loading={fetching}
                  loadingLabel="Saving…"
                  onClick={() => void saveAndFetch()}
                >
                  Save provider &amp; fetch models
                </Button>
              </div>
              {importedModels.length > 0 ? (
                <div className="row gap-1 wrap" style={{ marginTop: 8 }}>
                  <span className="helper" style={{ marginRight: 4 }}>
                    Imported ({importedModels.length}):
                  </span>
                  {importedModels.map((m) => (
                    <span className="badge badge--info" key={m.id}>
                      {m.id}
                    </span>
                  ))}
                </div>
              ) : null}
            </Field>
            <Field
              label="API key"
              htmlFor="f-key"
              helper="Stored locally (0600), never displayed again, never in a URL."
            >
              <PasswordInput
                id="f-key"
                large
                value={secret}
                onChange={setSecret}
                placeholder="Paste your key"
              />
            </Field>
            {fieldError ? (
              <Notice tone="warn" icon={TriangleAlert}>
                {fieldError}
              </Notice>
            ) : null}
          </div>
          <div className="row" style={{ justifyContent: "space-between", marginTop: 20 }}>
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
              <span className="v mono">{modelSummary || "— (none)"}</span>
              <span className="k">API key</span>
              <span className="v mono">•••••••• (saved on activate)</span>
            </div>
            {modelSummary ? (
              <Notice tone="warn" icon={TriangleAlert}>
                <span>
                  Grok Bot will restart and use <strong>{firstModel}</strong> on the next message. One model is active at a time.
                </span>
              </Notice>
            ) : (
              <Notice tone="info" icon={Info}>
                <span>No model yet — you can fetch models from the Models page after activation.</span>
              </Notice>
            )}
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
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

      <ImportModelsDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        providerName={name.trim()}
        existingSlugs={new Set(importedModels.map((m) => m.id))}
        catalogMatched={catalogMatched}
        result={fetchResult}
        error={fetchError}
        onImport={importChosen}
      />
    </div>
  );
}
