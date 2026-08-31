import { useEffect, useState } from "react";
import { go } from "./route";
import { ModelConfig } from "./ModelConfig";
import { BusyButton, prevent } from "./fields";
import { limitsFromModel, type ModelLimits } from "./model";
import type { Model, Provider } from "./api";

export function ModelPage({
  provider,
  model,
  busy,
  isOn,
  onSave,
  onUse,
}: {
  provider: Provider;
  model: Model;
  busy: boolean;
  isOn: boolean;
  onSave: (providerId: string, slug: string, limits: ModelLimits) => Promise<void>;
  onUse: (modelId: string) => void;
}) {
  const [limits, setLimits] = useState<ModelLimits>(() => limitsFromModel(model));
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState(false);

  useEffect(() => {
    setLimits(limitsFromModel(model));
    setNote("");
    setNoteError(false);
  }, [model.id, model.contextTokens, model.maxOutputTokens, model.reasoningLevels, model.modalities]);

  return (
    <div className="detail">
      <header className="detail-head">
        <div className="detail-head-copy">
          <nav className="crumb" aria-label="Breadcrumb">
            <button
              type="button"
              className="crumb-link"
              onClick={() => go({ kind: "provider", providerId: provider.id })}
            >
              {provider.name}
            </button>
            <span aria-hidden="true">/</span>
            <span className="crumb-current mono">{model.slug}</span>
          </nav>
          <h1 className="model-heading" id="model-title">
            {model.slug}
          </h1>
        </div>
        {isOn ? (
          <span className="badge badge-live">On</span>
        ) : (
          <button type="button" className="button-secondary" disabled={busy} onClick={() => onUse(model.id)}>
            Use this model
          </button>
        )}
      </header>

      <form
        onSubmit={prevent(async () => {
          setNote("");
          setNoteError(false);
          try {
            await onSave(model.providerId, model.slug, limits);
            setNote("Saved.");
          } catch (err) {
            setNote(err instanceof Error ? err.message : "Something went wrong");
            setNoteError(true);
          }
        })}
      >
        <ModelConfig value={limits} onChange={setLimits} />
        <div className="form-actions">
          <BusyButton type="submit" className="button-primary" busy={busy} busyLabel="Saving…">
            Save model
          </BusyButton>
          {note ? (
            <p className={noteError ? "fine error" : "fine"} role={noteError ? "alert" : "status"}>
              {note}
            </p>
          ) : null}
        </div>
      </form>
    </div>
  );
}
