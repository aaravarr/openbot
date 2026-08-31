import { ChipRadio } from "./ChipRadio";
import {
  MODALITIES,
  REASONING_LEVELS,
  isReasoningLevel,
  labelModality,
  labelReasoning,
  toggleModality,
  withReasoningToggle,
  type ModelLimits,
} from "./model";

export function ModelConfig({
  value,
  onChange,
  live = true,
}: {
  value: ModelLimits;
  onChange: (next: ModelLimits) => void;
  live?: boolean;
}) {
  return (
    <div className="model-config">
      <div className="limits-grid">
        <label>
          Context
          <input
            type="number"
            min={1}
            max={10000000}
            value={value.contextTokens}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (!Number.isFinite(next) || next <= 0) {
                return;
              }
              onChange({ ...value, contextTokens: Math.floor(next) });
            }}
          />
        </label>
        <label>
          Max output
          <input
            type="number"
            min={1}
            max={10000000}
            value={value.maxOutputTokens}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (!Number.isFinite(next) || next <= 0) {
                return;
              }
              onChange({ ...value, maxOutputTokens: Math.floor(next) });
            }}
          />
        </label>
      </div>
      {live ? (
        <div>
          <p className="model-config-title" id="active-reasoning-label">
            On Chat now
          </p>
          <ChipRadio
            labelledBy="active-reasoning-label"
            value={value.activeReasoning}
            options={value.reasoningLevels.map((level) => ({
              value: level,
              label: labelReasoning(level),
            }))}
            onChange={(level) => {
              if (isReasoningLevel(level)) {
                onChange({ ...value, activeReasoning: level });
              }
            }}
          />
          <p className="hint-soft">Pick one. This is what Grok Bot sends. Chat can change it later.</p>
        </div>
      ) : null}
      <div>
        <p className="model-config-title" id="reasoning-levels-label">
          Reasoning levels
        </p>
        <div className="chip-row" role="group" aria-labelledby="reasoning-levels-label">
          {REASONING_LEVELS.map((level) => {
            const on = value.reasoningLevels.includes(level);
            return (
              <button
                key={level}
                type="button"
                className={on ? "chip chip-on" : "chip"}
                aria-pressed={on}
                onClick={() => onChange(withReasoningToggle(value, level))}
              >
                {labelReasoning(level)}
              </button>
            );
          })}
        </div>
        <p className="hint-soft">
          Default omits thinking fields. Off sends an explicit disable. These chips choose what Chat can pick, not the
          live value.
        </p>
      </div>
      <div>
        <p className="model-config-title" id="modalities-label">
          Input types
        </p>
        <div className="chip-row" role="group" aria-labelledby="modalities-label">
          {MODALITIES.map((item) => {
            const on = value.modalities.includes(item);
            return (
              <button
                key={item}
                type="button"
                className={on ? "chip chip-on" : "chip"}
                aria-pressed={on}
                onClick={() => onChange({ ...value, modalities: toggleModality(value.modalities, item) })}
              >
                {labelModality(item)}
              </button>
            );
          })}
        </div>
        <p className="hint-soft">Image, video, and audio are saved on the model. Chat still sends text.</p>
      </div>
    </div>
  );
}
