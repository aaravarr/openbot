import { useMemo, useState } from "react";
import { BusyButton, InlineNote, SecretField, TextField, prevent } from "./fields";
import { PRESETS, type Preset } from "./presets";

export type ProviderDraft = {
  name: string;
  origin: string;
  modelSlug: string;
  secret: string;
};

const emptyDraft: ProviderDraft = { name: "", origin: "", modelSlug: "", secret: "" };

export function Setup({
  compact,
  busy,
  error,
  onSubmit,
  onCancel,
}: {
  compact?: boolean;
  busy: boolean;
  error: string;
  onSubmit: (draft: ProviderDraft) => Promise<void>;
  onCancel?: () => void;
}) {
  const [presetId, setPresetId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ProviderDraft>(emptyDraft);

  const preset = useMemo(
    () => PRESETS.find((row) => row.id === presetId) ?? null,
    [presetId],
  );

  function pick(next: Preset) {
    setPresetId(next.id);
    setDraft({
      name: next.name === "Custom" ? "" : next.name,
      origin: next.origin,
      modelSlug: next.model,
      secret: "",
    });
  }

  const formOpen = preset !== null;

  return (
    <section className={compact ? "setup setup-compact" : "setup"} aria-labelledby="setup-heading">
      <p className="kicker">{compact ? "Another provider" : "Get started"}</p>
      <h2 id="setup-heading" className="display">
        {compact ? "Add a provider" : "Use any model in Grok Bot"}
      </h2>
      <p className="lede">
        {compact
          ? "Same Grok Bot app. A different endpoint and key."
          : "Official Grok stays until you connect a provider. Keys stay on this Computer — never in chat."}
      </p>

      <div className="preset-grid">
        {PRESETS.map((row) => (
          <button
            key={row.id}
            type="button"
            className={presetId === row.id ? "preset selected" : "preset"}
            aria-pressed={presetId === row.id}
            onClick={() => pick(row)}
          >
            <span className="preset-name">{row.name}</span>
            <span className="preset-meta">
              {row.id === "custom" ? "OpenAI-compatible URL" : hostOf(row.origin)}
            </span>
          </button>
        ))}
      </div>

      {formOpen && preset ? (
        <form className="setup-form" onSubmit={prevent(() => onSubmit(draft))}>
          <p className="hint">{preset.hint}</p>
          <TextField
            name="name"
            label="Name"
            value={draft.name}
            required
            placeholder="OpenAI"
            onChange={(name) => setDraft((current) => ({ ...current, name }))}
          />
          <TextField
            name="origin"
            label="Base URL"
            type="url"
            mono
            value={draft.origin}
            required
            placeholder="https://api.openai.com/v1"
            onChange={(origin) => setDraft((current) => ({ ...current, origin }))}
          />
          <TextField
            name="modelSlug"
            label="Model ID"
            mono
            value={draft.modelSlug}
            required
            placeholder="gpt-4.1"
            onChange={(modelSlug) => setDraft((current) => ({ ...current, modelSlug }))}
          />
          <SecretField
            name="secret"
            label="API Key"
            value={draft.secret}
            required
            placeholder="sk-…"
            onChange={(secret) => setDraft((current) => ({ ...current, secret }))}
          />
          <div className="form-actions">
            <BusyButton type="submit" className="button-primary" busy={busy} busyLabel="Connecting…">
              Start chatting
            </BusyButton>
            {onCancel ? (
              <button type="button" className="button-tertiary" onClick={onCancel} disabled={busy}>
                Cancel
              </button>
            ) : null}
            <InlineNote text={error} error />
          </div>
        </form>
      ) : null}
    </section>
  );
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
