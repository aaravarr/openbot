import { isCustom, keyedSet, providerById, type BoxState } from "./api";

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
  onUse: (modelId: string) => void;
  onNeedKey: (providerId: string) => void;
}) {
  const custom = isCustom(state);
  const keyed = keyedSet(state);
  const officialOn = !custom;

  return (
    <section aria-labelledby="models-heading">
      <h2 id="models-heading" className="section-title">
        Models
      </h2>
      <p className="section-copy">Pick a model. The next message in Grok Bot follows that choice.</p>
      <div className="list-card">
        <button
          type="button"
          className={officialOn ? "choice choice-on" : "choice"}
          aria-pressed={officialOn}
          disabled={busyId !== null}
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
          return (
            <button
              key={model.id}
              type="button"
              className={on ? "choice choice-on" : "choice"}
              aria-pressed={on}
              disabled={busyId !== null}
              onClick={() => {
                if (!hasKey) {
                  onNeedKey(model.providerId);
                  return;
                }
                onUse(model.id);
              }}
            >
              <span className="choice-copy">
                <span className="choice-title mono">{model.slug}</span>
                <span className={hasKey ? "choice-meta" : "choice-meta warn"}>{meta}</span>
              </span>
              {on ? <span className="badge badge-live">On</span> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}
