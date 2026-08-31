import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuOption = { value: string; label: string };

type Box = { top: number; left: number; width: number; maxHeight: number };

export function MenuSelect({
  label,
  value,
  options,
  disabled,
  open,
  onOpenChange,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly MenuOption[];
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChange: (value: string) => void;
}) {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef(options);
  const activeRef = useRef(value);
  const [active, setActive] = useState(value);
  const [box, setBox] = useState<Box | null>(null);
  optionsRef.current = options;
  activeRef.current = active;

  useEffect(() => {
    if (open) {
      setActive(value);
      activeRef.current = value;
    }
  }, [open, value]);

  useLayoutEffect(() => {
    if (!open) {
      setBox(null);
      return;
    }

    function measure() {
      const trigger = triggerRef.current;
      if (!trigger) {
        return;
      }
      const rect = trigger.getBoundingClientRect();
      const width = Math.max(rect.width, 168);
      const rows = optionsRef.current;
      const estimated = Math.min(rows.length * 40 + 8, 280);
      const below = window.innerHeight - rect.bottom - 12;
      const up = below < estimated && rect.top > below;
      const maxHeight = Math.max(120, up ? rect.top - 12 : below);
      const top = up ? Math.max(8, rect.top - Math.min(estimated, maxHeight) - 4) : rect.bottom + 4;
      let left = rect.right - width;
      if (left < 8) {
        left = 8;
      }
      if (left + width > window.innerWidth - 8) {
        left = Math.max(8, window.innerWidth - width - 8);
      }
      setBox({ top, left, width, maxHeight });
    }

    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    function pickCurrent() {
      const rows = optionsRef.current;
      const current = rows.find((row) => row.value === activeRef.current) ?? rows[0];
      if (current) {
        onChange(current.value);
      }
      onOpenChange(false);
      triggerRef.current?.focus();
    }

    function move(delta: number) {
      const rows = optionsRef.current;
      const index = rows.findIndex((row) => row.value === activeRef.current);
      const start = index < 0 ? 0 : index;
      const next = rows[(start + delta + rows.length) % rows.length];
      if (next) {
        activeRef.current = next.value;
        setActive(next.value);
      }
    }

    function onDoc(event: PointerEvent) {
      const node = event.target;
      if (!(node instanceof Node)) {
        return;
      }
      if (triggerRef.current?.contains(node) || panelRef.current?.contains(node)) {
        return;
      }
      onOpenChange(false);
    }

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
        triggerRef.current?.focus();
        return;
      }
      if (event.key === "Tab") {
        onOpenChange(false);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        move(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        move(-1);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        const first = optionsRef.current[0];
        if (first) {
          activeRef.current = first.value;
          setActive(first.value);
        }
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        const rows = optionsRef.current;
        const last = rows[rows.length - 1];
        if (last) {
          activeRef.current = last.value;
          setActive(last.value);
        }
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        pickCurrent();
      }
    }

    document.addEventListener("pointerdown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onOpenChange, onChange]);

  const selected = options.find((row) => row.value === value) ?? options[0];
  const selectedLabel = selected?.label ?? value;

  function pick(next: string) {
    onChange(next);
    onOpenChange(false);
    triggerRef.current?.focus();
  }

  const panel =
    open && box && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={panelRef}
            className="menu-panel"
            role="listbox"
            id={listId}
            aria-label={label}
            style={{
              top: box.top,
              left: box.left,
              minWidth: box.width,
              maxHeight: box.maxHeight,
            }}
          >
            {options.map((row) => {
              const on = row.value === value;
              const hi = row.value === active;
              return (
                <button
                  key={row.value}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={on}
                  className={["menu-option", on ? "is-on" : "", hi ? "is-active" : ""].filter(Boolean).join(" ")}
                  onMouseEnter={() => {
                    activeRef.current = row.value;
                    setActive(row.value);
                  }}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    pick(row.value);
                  }}
                >
                  {row.label}
                </button>
              );
            })}
          </div>,
          document.body,
        )
      : null;

  return (
    <div className="line-intensity">
      <button
        ref={triggerRef}
        type="button"
        className={open ? "menu-trigger is-open" : "menu-trigger"}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!open) {
              onOpenChange(true);
            }
          }
          if (open && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
          }
        }}
      >
        <span className="menu-trigger-label">{selectedLabel}</span>
        <svg className="menu-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path
            d="M2.6 4.4 6 7.8l3.4-3.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {panel}
    </div>
  );
}
