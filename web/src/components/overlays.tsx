import { useEffect, useRef, type ReactNode } from "react";
import { ChevronRight, TriangleAlert, type LucideIcon } from "lucide-react";
import { Button } from "./ui";

function useFocusTrap(enabled: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;
    const prev = document.activeElement as HTMLElement | null;
    const focusables = (): HTMLElement[] =>
      Array.from(
        el.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((n) => !n.hasAttribute("disabled") && !n.closest("[hidden]") && n.getAttribute("aria-hidden") !== "true");

    const auto = el.querySelector<HTMLElement>("[data-autofocus]");
    const initial = auto ?? focusables()[0];
    initial?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0] as HTMLElement;
      const last = f[f.length - 1] as HTMLElement;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      prev?.focus?.();
    };
  }, [enabled]);
  return ref;
}

type ModalProps = {
  open: boolean;
  onClose: () => void;
  role?: "dialog" | "alertdialog";
  dismissable?: boolean;
  labelledBy?: string;
  describedBy?: string;
  drawer?: boolean;
  children: ReactNode;
};

export function Modal({
  open,
  onClose,
  role = "dialog",
  dismissable = true,
  labelledBy,
  describedBy,
  drawer = false,
  children,
}: ModalProps) {
  const ref = useFocusTrap(open);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, dismissable, onClose]);

  if (!open) return null;

  return (
    <div
      className={`overlay${drawer ? " overlay--drawer" : ""}`}
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && dismissable) onClose();
      }}
    >
      <div
        ref={ref}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
      >
        {children}
      </div>
    </div>
  );
}

/* ---------- Confirm dialog (destructive / deliberate actions) ---------- */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  consequences,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = true,
  busy = false,
  icon: Icon,
  iconTone = "warn",
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  consequences?: string[];
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  icon?: LucideIcon;
  iconTone?: "warn" | "accent" | "danger";
}) {
  const titleId = `confirm-${title.replace(/\s+/g, "-").toLowerCase()}`;
  return (
    <Modal
      open={open}
      onClose={onClose}
      role={destructive ? "alertdialog" : "dialog"}
      dismissable={!destructive}
      labelledBy={titleId}
    >
      <div className="dialog">
        <div className="dialog__head">
          <span className={`dialog__icon dialog__icon--${iconTone}`}>
            {Icon ? <Icon aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
          </span>
          <div>
            <div className="dialog__title" id={titleId}>
              {title}
            </div>
            {description ? <div className="dialog__desc">{description}</div> : null}
          </div>
        </div>
        {consequences?.length ? (
          <div className="consequence-list">
            {consequences.map((c) => (
              <div className="consequence" key={c}>
                <ChevronRight aria-hidden="true" />
                {c}
              </div>
            ))}
          </div>
        ) : null}
        <div className="dialog__foot">
          <Button variant="ghost" data-autofocus onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant={destructive ? "danger" : "primary"} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
