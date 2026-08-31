import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Dialog({
  title,
  titleClassName,
  aside,
  open,
  onClose,
  children,
}: {
  title: string;
  titleClassName?: string;
  aside?: ReactNode;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) {
      return;
    }
    lastFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    function focusables(): HTMLElement[] {
      if (!panel) {
        return [];
      }
      return [...panel.querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter(
        (node) => !node.hasAttribute("disabled") && node.getAttribute("aria-hidden") !== "true",
      );
    }
    const list = focusables();
    const preferred =
      list.find((node) => node.tagName === "INPUT" || node.tagName === "TEXTAREA") ??
      list.find((node) => !node.classList.contains("dialog-close")) ??
      list[0];
    preferred?.focus();

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const tab = focusables();
      if (tab.length === 0) {
        return;
      }
      const start = tab[0];
      const end = tab[tab.length - 1];
      if (event.shiftKey && document.activeElement === start) {
        event.preventDefault();
        end?.focus();
        return;
      }
      if (!event.shiftKey && document.activeElement === end) {
        event.preventDefault();
        start?.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
      lastFocus.current?.focus();
    };
  }, [open]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="dialog-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCloseRef.current();
        }
      }}
    >
      <div ref={panelRef} className="dialog-card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="dialog-head">
          <h2 id={titleId} className={titleClassName ? `dialog-title ${titleClassName}` : "dialog-title"}>
            {title}
          </h2>
          {aside}
          <button type="button" className="dialog-close" onClick={() => onCloseRef.current()}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
