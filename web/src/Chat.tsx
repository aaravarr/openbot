import {
  isCustom,
  keyedSet,
  modelById,
  providerById,
  type BoxState,
  type TunnelState,
} from "./api";
import { ChipRadio } from "./ChipRadio";
import { isReasoningLevel, labelReasoning, limitsFromModel } from "./model";
import { PhoneAccess } from "./PhoneAccess";

export function Chat({
  state,
  busy,
  onOfficial,
  onUse,
  onNeedKey,
  onExpose,
}: {
  state: BoxState;
  busy: boolean;
  onOfficial: () => void;
  onUse: (modelId: string, reasoning?: string) => void;
  onNeedKey: (providerId: string) => void;
  onExpose: (expose: "cloudflare" | "off") => void;
}) {
  const custom = isCustom(state);
  const keyed = keyedSet(state);
  const active = modelById(state, state.activeModelId);
  const activeProvider = active ? providerById(state, active.providerId) : undefined;
  const activeNeedsKey = Boolean(active && !keyed.has(active.providerId));
  const tunnel: TunnelState = state.snapshot?.tunnel ?? { kind: "off" };
  const levels = active ? limitsFromModel(active).reasoningLevels : [];
  const showThinking = Boolean(custom && active && !activeNeedsKey && levels.length > 0);
  const thinking =
    active && isReasoningLevel(active.activeReasoning) && levels.includes(active.activeReasoning)
      ? active.activeReasoning
      : "default";

  return (
    <section aria-labelledby="now-title">
      <div className="now">
        <p className="kicker">Now</p>
        {custom && active ? (
          <>
            <h1 className="identity-title mono" id="now-title">
              {active.slug}
            </h1>
            <p className="identity-sub">{activeNeedsKey ? `${activeProvider?.name ?? "Provider"} · needs an API key` : (activeProvider?.name ?? "")}</p>
          </>
        ) : (
          <>
            <h1 className="identity-title" id="now-title">
              Official Grok
            </h1>
            <p className="identity-sub">Stock xAI model in the Grok Bot app</p>
          </>
        )}
      </div>

      {showThinking && active ? (
        <div className="thinking-module">
          <p className="section-label" id="thinking-module-label">
            Thinking
          </p>
          <ChipRadio
            labelledBy="thinking-module-label"
            value={thinking}
            disabled={busy}
            options={levels.map((level) => ({ value: level, label: labelReasoning(level) }))}
            onChange={(level) => onUse(active.id, level)}
          />
          <p className="hint-soft">Grok Bot sends this on the next message.</p>
        </div>
      ) : null}

      <p className="section-label" id="models-heading">
        Models
      </p>
      <div className="list-card" role="list" aria-labelledby="models-heading">
        <button
          type="button"
          className={!custom ? "line is-on" : "line"}
          aria-pressed={!custom}
          disabled={busy}
          role="listitem"
          onClick={() => {
            if (!custom) {
              return;
            }
            onOfficial();
          }}
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
                if (on) {
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
                {need ? (
                  <span className="line-need">Needs key</span>
                ) : on ? (
                  <span className="badge badge-live">On</span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      <PhoneAccess tunnel={tunnel} busy={busy} onExpose={onExpose} />
      <p className="page-foot">
        Grok Bot uses one model at a time. Keys stay on this Computer. Send a new message after you switch.
      </p>
    </section>
  );
}
