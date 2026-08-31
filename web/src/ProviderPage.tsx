import { useCallback, useEffect, useState } from "react";
import { go } from "./route";
import { isCustom, keyedSet, modelsFor, type BoxState, type Model, type Provider } from "./api";
import { BusyButton, InlineNote, SecretField, TextField, prevent } from "./fields";
import { Dialog } from "./Dialog";
import { ModelConfig } from "./ModelConfig";
import { defaultLimits, formatTokens, limitsFromModel, type ModelLimits } from "./model";

type Sheet = "endpoint" | "key" | "add" | "remove" | null;

export function ProviderPage({
  state,
  provider,
  busy,
  focusKey,
  editModel,
  onAddModel,
  onSaveModel,
  onUpdate,
  onRemove,
  onUse,
  onCloseModel,
}: {
  state: BoxState;
  provider: Provider;
  busy: boolean;
  focusKey: boolean;
  editModel?: Model;
  onAddModel: (providerId: string, slug: string, limits: ModelLimits) => Promise<void>;
  onSaveModel: (providerId: string, slug: string, limits: ModelLimits) => Promise<void>;
  onUpdate: (input: { providerId: string; name: string; origin: string; secret?: string }) => Promise<void>;
  onRemove: (providerId: string) => Promise<void>;
  onUse: (modelId: string) => void;
  onCloseModel: () => void;
}) {
  const models = modelsFor(state, provider.id);
  const hasKey = keyedSet(state).has(provider.id);
  const liveId = isCustom(state) ? state.activeModelId : null;
  const [sheet, setSheet] = useState<Sheet>(null);
  const [slug, setSlug] = useState("");
  const [addLimits, setAddLimits] = useState<ModelLimits>(defaultLimits);
  const [editLimits, setEditLimits] = useState<ModelLimits>(() =>
    editModel ? limitsFromModel(editModel) : defaultLimits(),
  );
  const [name, setName] = useState(provider.name);
  const [origin, setOrigin] = useState(provider.origin);
  const [secret, setSecret] = useState("");
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState(false);

  const editOpen = Boolean(editModel);

  const closeSheets = useCallback(() => {
    setSheet(null);
    setSlug("");
    setAddLimits(defaultLimits());
    setName(provider.name);
    setOrigin(provider.origin);
    setSecret("");
  }, [provider.name, provider.origin]);

  function openSheet(next: Exclude<Sheet, null>) {
    if (editOpen) {
      onCloseModel();
    }
    setNote("");
    setNoteError(false);
    setSheet(next);
  }

  useEffect(() => {
    setSheet(null);
    setSlug("");
    setAddLimits(defaultLimits());
    setName(provider.name);
    setOrigin(provider.origin);
    setSecret("");
    setNote("");
    setNoteError(false);
  }, [provider.id, provider.name, provider.origin]);

  useEffect(() => {
    if (focusKey) {
      setSheet("key");
    }
  }, [focusKey, provider.id]);

  useEffect(() => {
    if (editModel) {
      setEditLimits(limitsFromModel(editModel));
      setSheet(null);
    }
  }, [editModel?.id, editModel?.contextTokens, editModel?.maxOutputTokens, editModel?.activeReasoning]);

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
    <div className="detail">
      <header className="detail-head">
        <div className="detail-head-copy">
          <h1 id="provider-title">{provider.name}</h1>
          <p className="caption-mono">{provider.origin}</p>
        </div>
        <div className="detail-head-actions">
          <button
            type="button"
            className="button-secondary nowrap"
            disabled={busy}
            aria-label="Edit endpoint"
            onClick={() => {
              setName(provider.name);
              setOrigin(provider.origin);
              openSheet("endpoint");
            }}
          >
            Edit
          </button>
          <button
            type="button"
            className="button-secondary nowrap"
            disabled={busy}
            aria-label={hasKey ? "Replace API key" : "Add API key"}
            onClick={() => {
              setSecret("");
              openSheet("key");
            }}
          >
            Key
          </button>
          <span className={hasKey ? "badge nowrap" : "badge badge-warn nowrap"}>{hasKey ? "Key saved" : "No API key"}</span>
        </div>
      </header>

      <div>
        <div className="section-head">
          <p className="section-label">Models</p>
          <button type="button" className="button-secondary nowrap" disabled={busy} onClick={() => openSheet("add")}>
            Add model
          </button>
        </div>
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
                    aria-label={`Edit ${model.slug}`}
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
                      <span className="badge badge-live nowrap">On</span>
                    ) : (
                      <button type="button" className="row-link nowrap" disabled={busy} onClick={() => onUse(model.id)}>
                        Use
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
        <p className="hint-soft">Open a model to edit limits. Use puts it on Chat. Thinking is chosen on Chat.</p>
      </div>

      {sheet === "remove" ? (
        <div className="confirm-row">
          <p className="fine">Remove {provider.name}? Models on it go away. Official Grok stays available.</p>
          <div className="confirm-actions">
            <button type="button" className="button-secondary nowrap" onClick={() => setSheet(null)}>
              Cancel
            </button>
            <BusyButton
              type="button"
              className="button-danger nowrap"
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
            onClick={() => openSheet("remove")}
          >
            Remove provider
          </button>
        </div>
      )}

      {sheet === null && !editOpen ? <InlineNote text={note} error={noteError} /> : null}

      <Dialog title="Endpoint" open={sheet === "endpoint"} onClose={closeSheets}>
        <form
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
            await run("Endpoint saved.", async () => {
              await onUpdate({
                providerId: provider.id,
                name: nextName,
                origin: nextOrigin,
              });
              closeSheets();
            });
          })}
        >
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
          <InlineNote text={note} error={noteError} />
          <div className="form-actions">
            <BusyButton type="submit" className="button-primary nowrap" busy={busy} busyLabel="Saving…">
              Save endpoint
            </BusyButton>
          </div>
        </form>
      </Dialog>

      <Dialog title={hasKey ? "Replace API key" : "API Key"} open={sheet === "key"} onClose={closeSheets}>
        <form
          className="stack-form"
          onSubmit={prevent(async () => {
            if (!secret.trim()) {
              setNote("Paste an API key.");
              setNoteError(true);
              return;
            }
            await run("API key saved.", async () => {
              await onUpdate({
                providerId: provider.id,
                name: provider.name,
                origin: provider.origin,
                secret: secret.trim(),
              });
              closeSheets();
            });
          })}
        >
          <SecretField
            name={`secret-${provider.id}`}
            label="API Key"
            value={secret}
            required
            placeholder="sk-…"
            onChange={setSecret}
          />
          <InlineNote text={note} error={noteError} />
          <div className="form-actions">
            <BusyButton type="submit" className="button-primary nowrap" busy={busy} busyLabel="Saving…">
              Save API Key
            </BusyButton>
          </div>
        </form>
      </Dialog>

      <Dialog title="New model" open={sheet === "add"} onClose={closeSheets}>
        <form
          className="stack-form"
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
              await onAddModel(provider.id, next, addLimits);
              closeSheets();
            });
          })}
        >
          <TextField
            name={`model-id-${provider.id}`}
            label="Model ID"
            mono
            value={slug}
            required
            placeholder="glm-5.3"
            onChange={setSlug}
          />
          <ModelConfig value={addLimits} onChange={setAddLimits} />
          <InlineNote text={note} error={noteError} />
          <div className="form-actions">
            <BusyButton type="submit" className="button-primary nowrap" busy={busy} busyLabel="Adding…">
              Add model
            </BusyButton>
          </div>
        </form>
      </Dialog>

      <Dialog
        title={editModel?.slug ?? "Model"}
        titleClassName="mono"
        open={editOpen}
        onClose={onCloseModel}
        aside={
          editModel ? (
            liveId === editModel.id ? (
              <span className="badge badge-live nowrap">On</span>
            ) : (
              <button type="button" className="button-secondary nowrap" disabled={busy} onClick={() => onUse(editModel.id)}>
                Use
              </button>
            )
          ) : null
        }
      >
        {editModel ? (
          <form
            className="stack-form"
            onSubmit={prevent(async () => {
              await run("Saved.", async () => {
                await onSaveModel(editModel.providerId, editModel.slug, editLimits);
                onCloseModel();
              });
            })}
          >
            <ModelConfig value={editLimits} onChange={setEditLimits} />
            <InlineNote text={note} error={noteError} />
            <div className="form-actions">
              <BusyButton type="submit" className="button-primary nowrap" busy={busy} busyLabel="Saving…">
                Save model
              </BusyButton>
            </div>
          </form>
        ) : null}
      </Dialog>
    </div>
  );
}
