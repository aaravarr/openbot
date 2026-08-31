import { isCustom, keyedSet, providerById, type BoxState } from "./api";
import { hasSelectableReasoning, isReasoningLevel, labelReasoning, limitsFromModel } from "./model";

export function Switcher({
  state,
  busyId,
  onOfficial,
  onUse,
  onNeedKey,
}: {
  state: BoxState;
  busyId: string | null;
  onOfficial: () => void;
  onUse: (modelId: string, reasoning?: string) => void;
  onNeedKey: (providerId: string) => void;
}) {
  const custom = isCustom(state);
  const keyed = keyedSet(state);
  const officialOn = !custom;
  const busy = busyId !== null;

  return (
    <section aria-labelledby="models-heading">
      <h2 id="models-heading" className="section-title">
        Models
      </h2>
      <p className="section-copy">Pick a model and a reasoning level. The next message in Grok Bot follows that choice.</p>
      <div className="list-card">
        <button
          type="button"
          className={officialOn ? "choice choice-on" : "choice"}
          aria-pressed={officialOn}
          disabled={busy}
          onClick={onOfficial}
        >
          <span className="choice-copy">
            <span className="choice-title">Official Grok</span>
            <span className="choice-meta">Stock xAI model in the Grok Bot app</span>
          </span>
          {officialOn ? <span className="badge badge-live">On</span> : null}
        </button>
        {state.models.map((model) => {
          const provider = providerById(state, model.providerId);
          const on = custom && state.activeModelId === model.id;
          const hasKey = keyed.has(model.providerId);
          const meta = [provider?.name, hasKey ? null : "needs an API key"].filter(Boolean).join(" · ");
          const limits = limitsFromModel(model);
          const showReasoning = hasSelectableReasoning(limits.reasoningLevels);
          return (
            <div key={model.id} className={on ? "choice-body choice-on" : "choice-body"}>
              <div className="choice-copy">
                <button
                  type="button"
                  className="choice-pick"
                  aria-pressed={on}
                  disabled={busy}
                  onClick={() => {
                    if (!hasKey) {
                      onNeedKey(model.providerId);
                      return;
                    }
                    onUse(model.id);
                  }}
                >
                  <span className="choice-title mono">{model.slug}</span>
                  <span className={hasKey ? "choice-meta" : "choice-meta warn"}>{meta}</span>
                </button>
                {showReasoning ? (
                  <div className="chip-row reason-row" role="group" aria-label={`Reasoning for ${model.slug}`}>
                    {limits.reasoningLevels.map((level) => {
                      const selected = on && model.activeReasoning === level;
                      return (
                        <button
                          key={level}
                          type="button"
                          className={selected ? "chip chip-on" : "chip"}
                          aria-pressed={selected}
                          disabled={busy}
                          onClick={() => {
                            if (!hasKey) {
                              onNeedKey(model.providerId);
                              return;
                            }
                            onUse(model.id, isReasoningLevel(level) ? level : undefined);
                          }}
                        >
                          {labelReasoning(level)}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
              {on ? <span className="badge badge-live">On</span> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
