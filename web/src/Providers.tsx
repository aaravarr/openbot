import { useState } from "react";
import { keyedSet, modelsFor, type BoxState, type Model } from "./api";
import { BusyButton, InlineNote, SecretField, prevent } from "./fields";
import { ModelConfig } from "./ModelConfig";
import { defaultLimits, formatModelMeta, limitsFromModel, type ModelLimits } from "./model";

export function Providers({
  state,
  busyId,
  focusProviderId,
  onAddModel,
  onSaveModel,
  onSetSecret,
  onRemove,
  onUse,
}: {
  state: BoxState;
  busyId: string | null;
  focusProviderId: string | null;
  onAddModel: (providerId: string, slug: string, limits: ModelLimits) => Promise<void>;
  onSaveModel: (providerId: string, slug: string, limits: ModelLimits) => Promise<void>;
  onSetSecret: (providerId: string, secret: string) => Promise<void>;
  onRemove: (providerId: string) => Promise<void>;
  onUse: (modelId: string) => void;
}) {
  return (
    <section aria-labelledby="providers-heading">
      <h2 id="providers-heading" className="section-title">
        Providers
      </h2>
      <p className="section-copy">Keys and model limits live here. Switching models is the list above.</p>
      <div className="stack">
        {state.providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            state={state}
            providerId={provider.id}
            busyId={busyId}
            focusKey={focusProviderId === provider.id}
            onAddModel={onAddModel}
            onSaveModel={onSaveModel}
            onSetSecret={onSetSecret}
            onRemove={onRemove}
            onUse={onUse}
          />
        ))}
      </div>
    </section>
  );
}

function ProviderCard({
  state,
  providerId,
  busyId,
  focusKey,
  onAddModel,
  onSaveModel,
  onSetSecret,
  onRemove,
  onUse,
}: {
  state: BoxState;
  providerId: string;
  busyId: string | null;
  focusKey: boolean;
  onAddModel: (providerId: string, slug: string, limits: ModelLimits) => Promise<void>;
  onSaveModel: (providerId: string, slug: string, limits: ModelLimits) => Promise<void>;
  onSetSecret: (providerId: string, secret: string) => Promise<void>;
  onRemove: (providerId: string) => Promise<void>;
  onUse: (modelId: string) => void;
}) {
  const provider = state.providers.find((row) => row.id === providerId);
  const models = modelsFor(state, providerId);
  const hasKey = keyedSet(state).has(providerId);
  const [slug, setSlug] = useState("");
  const [limits, setLimits] = useState<ModelLimits>(defaultLimits);
  const [secret, setSecret] = useState("");
  const [replaceKey, setReplaceKey] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState(false);
  const showKey = !hasKey || replaceKey || focusKey;
  const busy = busyId !== null;

  if (!provider) {
    return null;
  }

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

  return (
    <article
      className={focusKey ? "provider-card focus-card" : "provider-card"}
      id={`provider-${provider.id}`}
    >
      <header className="provider-head">
        <div>
          <h3 className="summary-name">{provider.name}</h3>
          <p className="summary-meta">{provider.origin}</p>
        </div>
        <span className={hasKey ? "badge" : "badge badge-warn"}>{hasKey ? "Key saved" : "No API key"}</span>
      </header>

      <ul className="model-list">
        {models.map((model) => (
          <ModelBlock
            key={model.id}
            state={state}
            model={model}
            busy={busy}
            hasKey={hasKey}
            onSaveModel={onSaveModel}
            onUse={onUse}
            onNote={run}
          />
        ))}
      </ul>

      <form
        className="stack-form"
        onSubmit={prevent(async () => {
          const next = slug.trim();
          if (!next) {
            return;
          }
          await run("Model added.", async () => {
            await onAddModel(provider.id, next, limits);
            setSlug("");
            setLimits(defaultLimits());
          });
        })}
      >
        <label className="inline-label">
          Add model
          <input
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder="Model ID"
            autoComplete="off"
            className="mono-input"
            aria-label="Model ID"
          />
        </label>
        <ModelConfig value={limits} onChange={setLimits} />
        <BusyButton type="submit" className="button-secondary" busy={busy} busyLabel="Adding…">
          Add
        </BusyButton>
      </form>

      {showKey ? (
        <form
          className="stack-form"
          onSubmit={prevent(async () => {
            await run("API key saved.", async () => {
              await onSetSecret(provider.id, secret);
              setSecret("");
              setReplaceKey(false);
            });
          })}
        >
          <SecretField
            name={`secret-${provider.id}`}
            label={hasKey ? "Replace API key" : "API Key"}
            value={secret}
            required
            placeholder="sk-…"
            onChange={setSecret}
          />
          <div className="form-actions">
            <BusyButton type="submit" className="button-primary" busy={busy} busyLabel="Saving…">
              Save API Key
            </BusyButton>
            {hasKey ? (
              <button
                type="button"
                className="button-tertiary"
                onClick={() => {
                  setReplaceKey(false);
                  setSecret("");
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      ) : (
        <button type="button" className="button-tertiary" onClick={() => setReplaceKey(true)}>
          Replace API key
        </button>
      )}

      {confirmRemove ? (
        <div className="confirm-row">
          <p className="fine">Remove {provider.name}? Models on it go away. Official Grok stays available.</p>
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
      ) : (
        <button type="button" className="button-tertiary danger-text" onClick={() => setConfirmRemove(true)}>
          Remove provider
        </button>
      )}

      <InlineNote text={note} error={noteError} />
    </article>
  );
}

function ModelBlock({
  state,
  model,
  busy,
  hasKey,
  onSaveModel,
  onUse,
  onNote,
}: {
  state: BoxState;
  model: Model;
  busy: boolean;
  hasKey: boolean;
  onSaveModel: (providerId: string, slug: string, limits: ModelLimits) => Promise<void>;
  onUse: (modelId: string) => void;
  onNote: (label: string, work: () => Promise<void>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [limits, setLimits] = useState(() => limitsFromModel(model));
  const on = state.snapshot?.wrap.kind === "openbot-marked" && state.activeModelId === model.id;

  return (
    <li className="model-block">
      <div className="model-row">
        <span className="model-copy">
          <span className="model-id">{model.slug}</span>
          <span className="model-meta">{formatModelMeta(model)}</span>
        </span>
        <span className="row-actions">
          {on ? (
            <span className="badge badge-live">On</span>
          ) : (
            <button type="button" className="button-secondary" disabled={busy || !hasKey} onClick={() => onUse(model.id)}>
              Use
            </button>
          )}
          <button
            type="button"
            className="button-tertiary"
            disabled={busy}
            onClick={() => {
              setLimits(limitsFromModel(model));
              setEditing((current) => !current);
            }}
          >
            {editing ? "Close" : "Edit"}
          </button>
        </span>
      </div>
      {editing ? (
        <form
          className="stack-form"
          onSubmit={prevent(async () => {
            await onNote("Model saved.", async () => {
              await onSaveModel(model.providerId, model.slug, limits);
              setEditing(false);
            });
          })}
        >
          <ModelConfig value={limits} onChange={setLimits} />
          <BusyButton type="submit" className="button-secondary" busy={busy} busyLabel="Saving…">
            Save model
          </BusyButton>
        </form>
      ) : null}
    </li>
  );
}
