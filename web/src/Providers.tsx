import { useState } from "react";
import { keyedSet, modelsFor, type BoxState } from "./api";
import { BusyButton, InlineNote, SecretField, prevent } from "./fields";

export function Providers({
  state,
  busyId,
  focusProviderId,
  onAddModel,
  onSetSecret,
  onRemove,
  onUse,
}: {
  state: BoxState;
  busyId: string | null;
  focusProviderId: string | null;
  onAddModel: (providerId: string, slug: string) => Promise<void>;
  onSetSecret: (providerId: string, secret: string) => Promise<void>;
  onRemove: (providerId: string) => Promise<void>;
  onUse: (modelId: string) => void;
}) {
  return (
    <section aria-labelledby="providers-heading">
      <h2 id="providers-heading" className="section-title">
        Providers
      </h2>
      <p className="section-copy">Keys and extra model ids live here. Switching models is the list above.</p>
      <div className="stack">
        {state.providers.map((provider) => (
          <ProviderCard
            key={provider.id}
            state={state}
            providerId={provider.id}
            busyId={busyId}
            focusKey={focusProviderId === provider.id}
            onAddModel={onAddModel}
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
  onSetSecret,
  onRemove,
  onUse,
}: {
  state: BoxState;
  providerId: string;
  busyId: string | null;
  focusKey: boolean;
  onAddModel: (providerId: string, slug: string) => Promise<void>;
  onSetSecret: (providerId: string, secret: string) => Promise<void>;
  onRemove: (providerId: string) => Promise<void>;
  onUse: (modelId: string) => void;
}) {
  const provider = state.providers.find((row) => row.id === providerId);
  const models = modelsFor(state, providerId);
  const hasKey = keyedSet(state).has(providerId);
  const [slug, setSlug] = useState("");
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
        {models.map((model) => {
          const on = state.snapshot?.wrap.kind === "openbot-marked" && state.activeModelId === model.id;
          return (
            <li key={model.id} className="model-row">
              <span className="model-id">{model.slug}</span>
              <span className="row-actions">
                {on ? (
                  <span className="badge badge-live">On</span>
                ) : (
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={busy || !hasKey}
                    onClick={() => onUse(model.id)}
                  >
                    Use
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>

      <form
        className="inline-form"
        onSubmit={prevent(async () => {
          const next = slug.trim();
          if (!next) {
            return;
          }
          await run("Model added.", async () => {
            await onAddModel(provider.id, next);
            setSlug("");
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
