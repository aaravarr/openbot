import { useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { CircleAlert, Eye, EyeOff } from "lucide-react";

export function Field({
  label,
  helper,
  error,
  children,
  htmlFor,
}: {
  label: ReactNode;
  helper?: ReactNode;
  error?: string;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="field">
      {label ? <label htmlFor={htmlFor}>{label}</label> : null}
      {children}
      {error ? (
        <span className="error" role="alert" aria-live="polite">
          <CircleAlert aria-hidden="true" />
          {error}
        </span>
      ) : helper ? (
        <span className="helper">{helper}</span>
      ) : null}
    </div>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement> & {
  mono?: boolean;
  invalid?: boolean;
  large?: boolean;
};

export function Input({ mono, invalid, large, className, ...rest }: InputProps) {
  const cls = ["input", mono ? "input--mono" : "", large ? "input--lg" : "", invalid ? "is-error" : "", className ?? ""]
    .filter(Boolean)
    .join(" ");
  return <input className={cls} {...rest} />;
}

export function PasswordInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  id,
  autoFocus,
  large,
  autoComplete,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  autoFocus?: boolean;
  large?: boolean;
  autoComplete?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <span className="pw-wrap">
      <Input
        id={id}
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoFocus={autoFocus}
        autoComplete={autoComplete ?? "off"}
        spellCheck={false}
        mono
        large={large}
      />
      <button
        type="button"
        className="pw-toggle"
        aria-label={show ? "Hide key" : "Show key"}
        aria-pressed={show}
        onClick={() => setShow((s) => !s)}
      >
        {show ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
      </button>
    </span>
  );
}

/** Number input with a shared id that coerces empties to null. */
export function NumberInput({
  value,
  onChange,
  id,
  min,
  max,
  className,
  ariaLabel,
}: {
  value: number | null;
  onChange: (next: number | null) => void;
  id?: string;
  min?: number;
  max?: number;
  className?: string;
  ariaLabel?: string;
}) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <Input
      id={inputId}
      type="number"
      className={className}
      value={value === null ? "" : value}
      min={min}
      max={max}
      aria-label={ariaLabel}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") {
          onChange(null);
          return;
        }
        const n = Number(raw);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}
