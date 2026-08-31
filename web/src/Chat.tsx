import { useState } from "react";
import {
  isCustom,
  keyedSet,
  modelById,
  providerById,
  type BoxState,
  type TunnelState,
} from "./api";
import { hasSelectableReasoning, isReasoningLevel, labelReasoning, limitsFromModel } from "./model";
import { MenuSelect } from "./MenuSelect";
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
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <section aria-labelledby="now-title">
      <div className="now">
        <p className="kicker">Now</p>
        {custom && active ? (
          <>
            <h1 className="identity-title mono" id="now-title">
              {active.slug}
            </h1>
            <p className="identity-sub">
              {activeNeedsKey
                ? `${activeProvider?.name ?? "Provider"} · needs an API key`
                : `${activeProvider?.name ?? ""}${active.activeReasoning ? ` · ${labelReasoning(active.activeReasoning)}` : ""}`}
            </p>
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
          const levels = limitsFromModel(model).reasoningLevels;
          const showIntensity = hasSelectableReasoning(levels);
          const current =
            isReasoningLevel(model.activeReasoning) && levels.includes(model.activeReasoning)
              ? model.activeReasoning
              : "default";
          const rowClass = ["line", "line-row", showIntensity ? "" : "line-row-plain", on ? "is-on" : ""]
            .filter(Boolean)
            .join(" ");
          return (
            <div key={model.id} className={rowClass} role="listitem">
              <button
                type="button"
                className="line-hit"
                aria-pressed={on}
                disabled={busy}
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
              </button>
              {showIntensity ? (
                <MenuSelect
                  label={`Thinking for ${model.slug}`}
                  value={current}
                  options={levels.map((level) => ({ value: level, label: labelReasoning(level) }))}
                  disabled={busy}
                  open={openId === model.id}
                  onOpenChange={(next) => {
                    if (next && need) {
                      onNeedKey(model.providerId);
                      return;
                    }
                    setOpenId(next ? model.id : null);
                  }}
                  onChange={(level) => {
                    if (need) {
                      onNeedKey(model.providerId);
                      return;
                    }
                    onUse(model.id, level);
                  }}
                />
              ) : null}
              <span className="line-aside">
                {need ? (
                  <span className="line-need">Needs key</span>
                ) : on ? (
                  <span className="badge badge-live">On</span>
                ) : null}
              </span>
            </div>
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
