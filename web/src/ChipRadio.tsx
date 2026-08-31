import { useRef } from "react";

export type ChipOption = { value: string; label: string };

export function ChipRadio({
  labelledBy,
  options,
  value,
  disabled,
  onChange,
}: {
  labelledBy: string;
  options: readonly ChipOption[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const root = useRef<HTMLDivElement>(null);

  function move(delta: number) {
    if (!options.length) {
      return;
    }
    const index = options.findIndex((row) => row.value === value);
    const start = index < 0 ? 0 : index;
    const next = options[(start + delta + options.length) % options.length];
    if (!next) {
      return;
    }
    onChange(next.value);
    queueMicrotask(() => {
      const node = root.current?.querySelector<HTMLElement>(`[data-chip="${CSS.escape(next.value)}"]`);
      node?.focus();
    });
  }

  return (
    <div
      ref={root}
      className="chip-row"
      role="radiogroup"
      aria-labelledby={labelledBy}
      onKeyDown={(event) => {
        if (disabled) {
          return;
        }
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          move(1);
        }
        if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          move(-1);
        }
      }}
    >
      {options.map((row) => {
        const on = row.value === value;
        return (
          <button
            key={row.value}
            type="button"
            role="radio"
            data-chip={row.value}
            className={on ? "chip chip-on" : "chip"}
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            disabled={disabled}
            onClick={() => {
              if (row.value !== value) {
                onChange(row.value);
              }
            }}
          >
            {row.label}
          </button>
        );
      })}
    </div>
  );
}
