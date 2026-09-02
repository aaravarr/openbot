import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Loader2, type LucideIcon } from "lucide-react";

/* ---------- Spinner ---------- */
export function Spinner({ size = 13 }: { size?: number }) {
  return <Loader2 className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

/* ---------- Button ---------- */
export type ButtonVariant =
  | "primary"
  | "primary-lg"
  | "secondary"
  | "secondary-sm"
  | "ink"
  | "danger"
  | "ghost"
  | "ghost-sm"
  | "ghost-danger"
  | "ghost-danger-sm";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  icon?: LucideIcon;
  loading?: boolean;
  loadingLabel?: string;
  children?: ReactNode;
};

export function Button({
  variant = "secondary",
  icon: Icon,
  loading = false,
  loadingLabel,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  const cls = `btn btn--${variant}`;
  const label = loading && loadingLabel ? loadingLabel : children;
  return (
    <button type={type} className={cls} disabled={disabled || loading} {...rest}>
      {loading ? <Spinner /> : Icon ? <Icon aria-hidden="true" /> : null}
      {label}
    </button>
  );
}

/* ---------- Icon button ---------- */
type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon: LucideIcon;
  loading?: boolean;
};

export function IconButton({
  label,
  icon: Icon,
  type = "button",
  loading = false,
  className,
  disabled,
  ...rest
}: IconButtonProps) {
  const cls = ["icon-btn", className].filter(Boolean).join(" ");
  return (
    <button
      type={type}
      {...rest}
      className={cls}
      aria-label={label}
      title={label}
      disabled={disabled || loading}
    >
      {loading ? <Spinner size={16} /> : <Icon aria-hidden="true" />}
    </button>
  );
}

/* ---------- Badge ---------- */
export function Badge({
  tone,
  icon: Icon,
  children,
}: {
  tone?: "success" | "warning" | "danger" | "info" | "accent";
  icon?: LucideIcon;
  children: ReactNode;
}) {
  return (
    <span className={`badge${tone ? ` badge--${tone}` : ""}`}>
      {Icon ? <Icon aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/* ---------- Status pill ---------- */
export function StatusPill({ status }: { status: number | string }) {
  const code = Number(status);
  const tone = Number.isFinite(code) && code >= 400 ? "err" : "ok";
  return <span className={`status-pill status-pill--${tone}`}>{status}</span>;
}

/* ---------- Mode pill ---------- */
export function ModePill({ mode, model }: { mode: "official" | "custom"; model?: string | null }) {
  if (mode === "official") {
    return <span className="mode-pill mode-pill--official">Official</span>;
  }
  const slug = model ?? "—";
  return (
    <span className="mode-pill mode-pill--custom" title={slug} aria-label={`Custom ${slug}`}>
      Custom
      <span className="mode-pill__divider" aria-hidden="true" />
      <span className="mode-pill__model">{slug}</span>
    </span>
  );
}

/* ---------- Param chip (reasoning levels) ---------- */
export function ParamChip({
  active,
  pinned,
  isStatic,
  disabled,
  onClick,
  children,
}: {
  active?: boolean;
  pinned?: boolean;
  isStatic?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  const cls = [
    "param-chip",
    active ? "is-active" : "",
    pinned ? "is-pinned" : "",
    isStatic ? "is-static" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button type="button" className={cls} disabled={disabled || pinned || isStatic} onClick={onClick} aria-pressed={active}>
      {children}
    </button>
  );
}

/* ---------- Toggle switch ---------- */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className="switch">
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="switch__track">
        <span className="switch__thumb" />
      </span>
      <span className="switch__label">{label}</span>
    </label>
  );
}

/* ---------- Health dot ---------- */
export type DotState = "ok" | "warn" | "fault" | "off";
export function HealthDot({ state, label }: { state: DotState; label: string }) {
  return <span className={`health-dot health-dot--${state}`} role="img" aria-label={label} />;
}

/* ---------- Skeleton ---------- */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <div className={`skel ${className ?? ""}`} style={style} aria-hidden="true" />;
}

export function SkeletonRow() {
  return <div className="skel skel--row" aria-hidden="true" />;
}

/* ---------- Empty state ---------- */
export function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty__tile">
        <Icon aria-hidden="true" />
      </span>
      <h3>{title}</h3>
      <p>{body}</p>
      {action ? <div className="actions">{action}</div> : null}
    </div>
  );
}

/* ---------- Inline notice ---------- */
export function Notice({
  tone,
  icon: Icon,
  children,
}: {
  tone: "info" | "warn" | "danger";
  icon: LucideIcon;
  children: ReactNode;
}) {
  return (
    <div className={`notice notice--${tone}`}>
      <Icon aria-hidden="true" />
      <span className="text">{children}</span>
    </div>
  );
}
