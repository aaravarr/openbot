import { useEffect, useRef, useState } from "react";
import { go } from "./route";
import { keyedSet, modelsFor, type BoxState, type Provider } from "./api";
import { BusyButton, InlineNote, SecretField, TextField, prevent } from "./fields";
import { ModelConfig } from "./ModelConfig";
import { defaultLimits, formatTokens, limitsFromModel, type ModelLimits } from "./model";

export function ProviderPage({
  state,
  provider,
  busy,
  focusKey,
  onAddModel,
  onUpdate,
  onRemove,
  onUse,
}: {
  state: BoxState;
  provider: Provider;
  busy: boolean;
  focusKey: boolean;
  onAddModel: (providerId: string, slug: string, limits: ModelLimits) => Promise<void>;
  onUpdate: (input: { providerId: string; name: string; origin: string; secret?: string }) => Promise<void>;
  onRemove: (providerId: string) => Promise<void>;
  onUse: (modelId: string) => void;
}) {
  const models = modelsFor(state, provider.id);
  const hasKey = keyedSet(state).has(provider.id);
  const liveId = state.snapshot?.wrap.kind === "openbot-marked" ? state.activeModelId : null;
  const [adding, setAdding] = useState(false);
  const [slug, setSlug] = useState("");
  const [limits, setLimits] = useState<ModelLimits>(defaultLimits);
  const [name, setName] = useState(provider.name);
  const [origin, setOrigin] = useState(provider.origin);
  const [secret, setSecret] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState(false);
  const keyField = useRef<HTMLFormElement>(null);
  const slugField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAdding(false);
    setSlug("");
    setLimits(defaultLimits());
    setName(provider.name);
    setOrigin(provider.origin);
    setSecret("");
    setConfirmRemove(false);
    setNote("");
    setNoteError(false);
  }, [provider.id, provider.name, provider.origin]);

  useEffect(() => {
    if (!focusKey) {
      return;
    }
    keyField.current?.querySelector("input")?.focus();
  }, [focusKey, provider.id]);

  useEffect(() => {
    if (adding) {
      slugField.current?.focus();
    }
  }, [adding]);

  async function run(label: string, work: () => Promise<void>) {
    setNote("");
    setNoteError(false);
    try {
      await work();
      setNote(label);
      setNoteError(false);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Something went wrong");
      setNoteError(true);
    }
  }

  function closeAdd() {
    setAdding(false);
    setSlug("");
    setLimits(defaultLimits());
  }

  return (
    <div className="detail">
      <header className="detail-head">
        <div className="detail-head-copy">
          <h1 id="provider-title">{provider.name}</h1>
          <p className="caption-mono">{provider.origin}</p>
        </div>
        <span className={hasKey ? "badge" : "badge badge-warn"}>{hasKey ? "Key saved" : "No API key"}</span>
      </header>

      <form
        ref={keyField}
        className="stack-form"
        onSubmit={prevent(async () => {
          const nextName = name.trim();
          const nextOrigin = origin.trim();
          if (!nextName) {
            setNote("Enter a name.");
            setNoteError(true);
            return;
          }
          if (!nextOrigin) {
            setNote("Enter a base URL.");
            setNoteError(true);
            return;
          }
          if (!hasKey && !secret.trim()) {
            setNote("Paste an API key.");
            setNoteError(true);
            return;
          }
          await run("Provider saved.", async () => {
            await onUpdate({
              providerId: provider.id,
              name: nextName,
              origin: nextOrigin,
              ...(secret.trim() ? { secret: secret.trim() } : {}),
            });
            setSecret("");
          });
        })}
      >
        <p className="section-label">Endpoint</p>
        <TextField name={`name-${provider.id}`} label="Name" value={name} required onChange={setName} />
        <TextField
          name={`origin-${provider.id}`}
          label="Base URL"
          type="url"
          mono
          value={origin}
          required
          placeholder="https://api.openai.com/v1"
          onChange={setOrigin}
        />
        <SecretField
          name={`secret-${provider.id}`}
          label="API Key"
          value={secret}
          required={!hasKey}
          placeholder={hasKey ? "Leave blank to keep the saved key" : "sk-…"}
          onChange={setSecret}
        />
        <div className="form-actions">
          <BusyButton type="submit" className="button-primary" busy={busy} busyLabel="Saving…">
            Save provider
          </BusyButton>
        </div>
      </form>

      <div>
        <p className="section-label">Models</p>
        <div className="model-rows">
          {models.length === 0 ? (
            <p className="fine empty">No models yet.</p>
          ) : (
            models.map((model) => {
              const on = liveId === model.id;
              const meta = limitsFromModel(model);
              return (
                <div key={model.id} className="model-row">
                  <button
                    type="button"
                    className="model-row-hit"
                    aria-label={`Configure ${model.slug}`}
                    onClick={() =>
                      go({
                        kind: "model",
                        providerId: provider.id,
                        modelId: model.id,
                      })
                    }
                  >
                    <span className="model-id">{model.slug}</span>
                    <span className="model-meta">{formatTokens(meta.contextTokens)} context</span>
                  </button>
                  <div className="model-row-actions">
                    {on ? (
                      <span className="badge badge-live">On</span>
                    ) : (
                      <button type="button" className="row-link" disabled={busy} onClick={() => onUse(model.id)}>
                        Use
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
        <p className="hint-soft">Open a model to configure limits. Use puts it on Chat.</p>
      </div>

      {adding ? (
        <form
          className="add-model-form"
          onSubmit={prevent(async () => {
            const next = slug.trim();
            if (!next) {
              setNote("Enter a model ID.");
              setNoteError(true);
              return;
            }
            if (models.some((row) => row.slug === next)) {
              setNote("That model is already on this provider.");
              setNoteError(true);
              return;
            }
            await run(`Added ${next}.`, async () => {
              await onAddModel(provider.id, next, limits);
              closeAdd();
            });
          })}
        >
          <p className="section-label">New model</p>
          <label>
            Model ID
            <input
              ref={slugField}
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              placeholder="glm-5.3"
              autoComplete="off"
              className="mono-input"
              disabled={busy}
            />
          </label>
          <ModelConfig value={limits} onChange={setLimits} live={false} />
          <div className="form-actions">
            <BusyButton type="submit" className="button-secondary" busy={busy} busyLabel="Adding…">
              Add
            </BusyButton>
            <button type="button" className="button-tertiary" disabled={busy} onClick={closeAdd}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="button-tertiary" disabled={busy} onClick={() => setAdding(true)}>
          Add model
        </button>
      )}

      {confirmRemove ? (
        <div className="confirm-row">
          <p className="fine">Remove {provider.name}? Models on it go away. Official Grok stays available.</p>
          <div className="confirm-actions">
            <button type="button" className="button-secondary" onClick={() => setConfirmRemove(false)}>
              Cancel
            </button>
            <BusyButton
              type="button"
              className="button-danger"
              busy={busy}
              busyLabel="Removing…"
              onClick={() => run("Provider removed.", () => onRemove(provider.id))}
            >
              Remove
            </BusyButton>
          </div>
        </div>
      ) : (
        <div className="danger-zone">
          <button
            type="button"
            className="button-tertiary danger-text"
            disabled={busy}
            onClick={() => setConfirmRemove(true)}
          >
            Remove provider
          </button>
        </div>
      )}

      <InlineNote text={note} error={noteError} />
    </div>
  );
}
