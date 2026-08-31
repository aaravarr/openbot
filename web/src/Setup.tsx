import { draftFromPreset, PRESETS, type Preset, type ProviderDraft } from "./presets";
import { BusyButton, InlineNote, SecretField, TextField, prevent } from "./fields";
import { defaultLimits } from "./model";
import { useState } from "react";

export type { ProviderDraft };

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
  const [preset, setPreset] = useState<Preset | null>(null);
  const [draft, setDraft] = useState<ProviderDraft>(emptyDraft());

  function pick(next: Preset) {
    setPreset(next);
    setDraft(draftFromPreset(next));
  }

  function backToPresets() {
    setPreset(null);
    setDraft(emptyDraft());
  }

  if (!preset) {
    return (
      <section className={compact ? "setup setup-compact" : "setup"} aria-labelledby="setup-heading">
        <p className="kicker">{compact ? "Another provider" : "Get started"}</p>
        <h1 id="setup-heading" className="display">
          {compact ? "Add a provider" : "Use any model in Grok Bot"}
        </h1>
        <p className="lede">
          {compact
            ? "Same Grok Bot app. A different endpoint and key."
            : "Official Grok stays until you connect a provider. Keys stay on this Computer — never in chat."}
        </p>
        {compact ? null : (
          <ol className="steps">
            <li>Pick a provider</li>
            <li>Paste a key</li>
            <li>Send a message in Grok Bot</li>
          </ol>
        )}
        <p className="section-label">Choose a provider to continue.</p>
        <div className="preset-grid">
          {PRESETS.map((row) => (
            <button
              key={row.id}
              type="button"
              className={row.id === "custom" ? "preset preset-wide" : "preset"}
              onClick={() => pick(row)}
            >
              <span className="preset-name">{row.name}</span>
              <span className="preset-meta">
                {row.id === "custom" ? "OpenAI-compatible URL" : hostOf(row.origin)}
              </span>
            </button>
          ))}
        </div>
        {onCancel ? (
          <div className="form-actions">
            <button type="button" className="button-tertiary" onClick={onCancel}>
              Cancel
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  const custom = preset.id === "custom";
  return (
    <section className={compact ? "setup setup-compact" : "setup"} aria-labelledby="setup-heading">
      <p className="kicker">Connect</p>
      <h1 id="setup-heading" className="display">
        {custom ? "Your endpoint" : preset.name}
      </h1>
      <p className="lede">{preset.hint}</p>
      <form className="setup-form setup-form-open" key={preset.id} onSubmit={prevent(() => onSubmit(draft))}>
        <TextField
          name="name"
          label="Name"
          value={draft.name}
          required
          placeholder={custom ? "My endpoint" : "OpenAI"}
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
          placeholder={custom ? "my-model" : "gpt-4.1"}
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
          <button type="button" className="button-tertiary" onClick={backToPresets} disabled={busy}>
            Change provider
          </button>
          {onCancel ? (
            <button type="button" className="button-tertiary" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          ) : null}
          <InlineNote text={error} error />
        </div>
      </form>
    </section>
  );
}

function emptyDraft(): ProviderDraft {
  return { name: "", origin: "", modelSlug: "", secret: "", ...defaultLimits() };
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
