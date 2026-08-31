import {
  isCustom,
  keyedSet,
  modelById,
  providerById,
  type BoxState,
} from "./api";
import { hasSelectableReasoning, labelReasoning, limitsFromModel } from "./model";

export function Chat({
  state,
  busy,
  onOfficial,
  onUse,
  onNeedKey,
}: {
  state: BoxState;
  busy: boolean;
  onOfficial: () => void;
  onUse: (modelId: string, reasoning?: string) => void;
  onNeedKey: (providerId: string) => void;
}) {
  const custom = isCustom(state);
  const keyed = keyedSet(state);
  const active = modelById(state, state.activeModelId);
  const activeProvider = active ? providerById(state, active.providerId) : undefined;
  const last = modelById(state, state.activeModelId);
  const limits = active ? limitsFromModel(active) : null;
  const showReason = custom && active && hasSelectableReasoning(limits?.reasoningLevels);

  return (
    <section aria-labelledby="now-title">
      <div className="now">
        <p className="kicker">Now</p>
        {custom && active ? (
          <>
            <h1 className="identity-title mono" id="now-title">
              {active.slug}
            </h1>
            <p className="identity-sub">{activeProvider?.name ?? ""}</p>
          </>
        ) : (
          <>
            <h1 className="identity-title" id="now-title">
              Official Grok
            </h1>
            <p className="identity-sub">Stock xAI model in the Grok Bot app</p>
          </>
        )}

        {showReason && active ? (
          <div className="reason-block">
            <p className="section-label">Reasoning</p>
            <div className="chip-row" role="group" aria-label={`Reasoning for ${active.slug}`}>
              {limits?.reasoningLevels.map((level) => {
                const on = active.activeReasoning === level;
                return (
                  <button
                    key={level}
                    type="button"
                    className={on ? "chip chip-on" : "chip"}
                    aria-pressed={on}
                    disabled={busy}
                    onClick={() => onUse(active.id, level)}
                  >
                    {labelReasoning(level)}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {custom ? (
          <div className="now-actions">
            <button type="button" className="button-secondary" disabled={busy} onClick={onOfficial}>
              Use official Grok
            </button>
          </div>
        ) : last ? (
          <div className="now-actions">
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() => {
                if (!keyed.has(last.providerId)) {
                  onNeedKey(last.providerId);
                  return;
                }
                onUse(last.id);
              }}
            >
              Use {last.slug}
            </button>
          </div>
        ) : null}
      </div>

      <p className="section-label" id="models-heading">
        This chat
      </p>
      <div className="list-card" role="list" aria-labelledby="models-heading">
        <button
          type="button"
          className={!custom ? "line is-on" : "line"}
          aria-pressed={!custom}
          disabled={busy}
          role="listitem"
          onClick={onOfficial}
        >
          <span className="line-main">
            <span className="line-plain">Official Grok</span>
          </span>
          <span className="line-aside">{!custom ? <span className="badge badge-live">On</span> : null}</span>
        </button>
        {state.models.map((model) => {
          const provider = providerById(state, model.providerId);
          const on = custom && state.activeModelId === model.id;
          const need = !keyed.has(model.providerId);
          return (
            <button
              key={model.id}
              type="button"
              className={on ? "line is-on" : "line"}
              aria-pressed={on}
              disabled={busy}
              role="listitem"
              onClick={() => {
                if (need) {
                  onNeedKey(model.providerId);
                  return;
                }
                onUse(model.id);
              }}
            >
              <span className="line-main">
                <span className="line-slug">{model.slug}</span>
                <span className="line-sep">·</span>
                <span className="line-provider">{provider?.name ?? ""}</span>
              </span>
              <span className="line-aside">
                {on ? (
                  <span className="badge badge-live">On</span>
                ) : need ? (
                  <span className="line-need">Needs key</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      <p className="page-foot">
        Keys stay on this Computer. Send a new message in Grok Bot after you switch.
      </p>
    </section>
  );
}
