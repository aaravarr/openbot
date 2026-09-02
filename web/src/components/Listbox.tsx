import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Check, ChevronDown, Search } from "lucide-react";

export type ListboxOption = {
  value: string;
  label: string;
  sublabel?: string;
  badges?: ReactNode;
};

export type ListboxGroup = {
  label: string;
  options: ListboxOption[];
};

type ListboxProps = {
  groups: ListboxGroup[];
  value: string | null;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
  placeholder?: string;
  triggerStyle?: React.CSSProperties;
};

type FlatOption = { option: ListboxOption; groupLabel: string };

export function Listbox({
  groups,
  value,
  onChange,
  label,
  disabled,
  placeholder,
  triggerStyle,
}: ListboxProps) {
  const uid = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const [up, setUp] = useState(false);

  const totalOptions = useMemo(() => groups.reduce((n, g) => n + g.options.length, 0), [groups]);
  const showSearch = totalOptions > 8;

  const selectedOption = useMemo(() => {
    for (const g of groups) {
      const hit = g.options.find((o) => o.value === value);
      if (hit) return hit;
    }
    return undefined;
  }, [groups, value]);

  const visible: FlatOption[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: FlatOption[] = [];
    for (const g of groups) {
      for (const o of g.options) {
        const hay = `${o.label} ${o.sublabel ?? ""}`.toLowerCase();
        if (!q || hay.includes(q)) out.push({ option: o, groupLabel: g.label });
      }
    }
    return out;
  }, [groups, query]);

  const visibleGroups = useMemo(() => {
    const labels = new Set(visible.map((v) => v.groupLabel));
    return groups.filter((g) => labels.has(g.label));
  }, [groups, visible]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(-1);
  }, []);

  const openPanel = useCallback(() => {
    if (disabled) return;
    setOpen(true);
    setQuery("");
    const sel = visible.find((v) => v.option.value === value);
    setActiveIndex(sel ? visible.indexOf(sel) : visible.length ? 0 : -1);
    // collision-aware placement
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      setUp(spaceBelow < 320 && spaceAbove > spaceBelow);
    }
  }, [disabled, value, visible]);

  useEffect(() => {
    if (!open) return;
    if (showSearch && searchRef.current) {
      searchRef.current.focus();
      searchRef.current.select();
    } else {
      listRef.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, showSearch]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  const select = useCallback(
    (opt: ListboxOption) => {
      onChange(opt.value);
      close();
      triggerRef.current?.focus();
    },
    [onChange, close],
  );

  const optionId = (flat: FlatOption): string => `${uid}-opt-${flat.option.value.replace(/[^a-zA-Z0-9]/g, "_")}`;

  const indexByOption = useMemo(() => {
    const map = new Map<ListboxOption, number>();
    visible.forEach((v, i) => map.set(v.option, i));
    return map;
  }, [visible]);

  useEffect(() => {
    const id = activeIndex >= 0 ? optionId(visible[activeIndex] as FlatOption) : undefined;
    if (id) {
      document.getElementById(id)?.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, visible, uid]);

  const move = useCallback(
    (delta: number) => {
      if (!visible.length) return;
      setActiveIndex((prev) => {
        const next = prev < 0 ? 0 : (prev + delta + visible.length) % visible.length;
        return next;
      });
    },
    [visible.length],
  );

  const handleTriggerKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openPanel();
    }
  };

  const handleListKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(visible.length ? 0 : -1);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(visible.length ? visible.length - 1 : -1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const opt = visible[activeIndex];
      if (opt) select(opt.option);
    }
  };

  const handleSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(1);
      listRef.current?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const first = visible[0];
      if (first) select(first.option);
    }
  };

  const triggerLabel = selectedOption ? selectedOption.label : placeholder ?? "Select…";

  return (
    <div className="listbox" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="listbox__trigger"
        style={triggerStyle}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${uid}-panel`}
        aria-label={label}
        disabled={disabled}
        onClick={() => (open ? close() : openPanel())}
        onKeyDown={handleTriggerKey}
      >
        <span className="listbox__value">{triggerLabel}</span>
        <ChevronDown className={`listbox__chevron${open ? " is-open" : ""}`} aria-hidden="true" />
      </button>

      {open ? (
        <div className={`listbox__panel${up ? " is-up" : ""}`} id={`${uid}-panel`} role="presentation">
          {showSearch ? (
            <div className="listbox__search">
              <Search className="listbox__search-icon" aria-hidden="true" />
              <input
                ref={searchRef}
                className="input"
                type="text"
                placeholder="Search models…"
                aria-label={label ? `Search ${label}` : "Search options"}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActiveIndex(0);
                }}
                onKeyDown={handleSearchKey}
              />
            </div>
          ) : null}
          <div
            className="listbox__list"
            role="listbox"
            tabIndex={-1}
            aria-label={label ?? "Options"}
            aria-activedescendant={
              activeIndex >= 0 ? optionId(visible[activeIndex] as FlatOption) : undefined
            }
            ref={listRef}
            onKeyDown={handleListKey}
          >
            {visibleGroups.map((g) => (
              <div className="listbox__group" key={g.label}>
                <div className="listbox__group-label">{g.label}</div>
                {g.options
                  .filter((o) => indexByOption.has(o))
                  .map((o) => {
                    const flat = { option: o, groupLabel: g.label };
                    const idx = indexByOption.get(o) ?? -1;
                    const selected = o.value === value;
                    return (
                      <button
                        type="button"
                        key={o.value}
                        id={optionId(flat)}
                        role="option"
                        aria-selected={selected}
                        className={[
                          "listbox__option",
                          idx === activeIndex ? "is-active" : "",
                          selected ? "is-selected" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        onClick={() => select(o)}
                        onMouseEnter={() => setActiveIndex(idx)}
                      >
                        <span className="listbox__name">{o.label}</span>
                        {o.sublabel ? <span className="cell-sub">{o.sublabel}</span> : null}
                        <span className="listbox__badges">{o.badges}</span>
                        <Check className="listbox__check" aria-hidden="true" />
                      </button>
                    );
                  })}
              </div>
            ))}
            {!visible.length ? <div className="listbox__empty">No models match.</div> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
