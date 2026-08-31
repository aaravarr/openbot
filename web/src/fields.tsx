import type { ButtonHTMLAttributes, FormEvent } from "react";
import { useId, useState } from "react";

export function BusyButton({
  busy,
  busyLabel,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; busyLabel?: string }) {
  return (
    <button
      {...props}
      className={className}
      disabled={Boolean(props.disabled) || Boolean(busy)}
      aria-busy={busy ? true : undefined}
    >
      {busy ? busyLabel || "Working…" : children}
    </button>
  );
}

export function SecretField({
  name,
  value,
  onChange,
  required,
  placeholder,
  label,
}: {
  name: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  placeholder?: string;
  label: string;
}) {
  const id = useId();
  const [show, setShow] = useState(false);
  return (
    <label htmlFor={id}>
      {label}
      <span className="password-field">
        <input
          id={id}
          name={name}
          type={show ? "text" : "password"}
          value={value}
          required={required}
          placeholder={placeholder}
          autoComplete="new-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
        <button type="button" className="button-tertiary" onClick={() => setShow((current) => !current)}>
          {show ? "Hide" : "Show"}
        </button>
      </span>
    </label>
  );
}

export function TextField({
  name,
  value,
  onChange,
  required,
  placeholder,
  label,
  type = "text",
  mono,
}: {
  name: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  placeholder?: string;
  label: string;
  type?: string;
  mono?: boolean;
}) {
  const id = useId();
  return (
    <label htmlFor={id}>
      {label}
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        required={required}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className={mono ? "mono-input" : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function InlineNote({ text, error }: { text: string; error?: boolean }) {
  if (!text) {
    return null;
  }
  return (
    <p className={error ? "fine error" : "fine"} role={error ? "alert" : "status"}>
      {text}
    </p>
  );
}

export function prevent(handler: () => void | Promise<void>) {
  return (event: FormEvent) => {
    event.preventDefault();
    void handler();
  };
}
