import { useEffect, useState } from "react";
import { KeyRound, Pencil } from "lucide-react";
import type { Provider } from "../api/types";
import { Button } from "./ui";
import { Field, Input, PasswordInput } from "./fields";
import { Modal } from "./overlays";

export function EditProviderDialog({
  open,
  onClose,
  provider,
  busy,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  provider: Provider | null;
  busy?: boolean;
  onSave: (name: string, origin: string) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && provider) {
      setName(provider.name);
      setOrigin(provider.origin);
      setError(null);
    }
  }, [open, provider]);

  const submit = async () => {
    const n = name.trim();
    const o = origin.trim();
    if (!n) {
      setError("Name is required.");
      return;
    }
    if (!o) {
      setError("Base URL is required.");
      return;
    }
    setError(null);
    await onSave(n, o);
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="ep-title">
      <div className="dialog">
        <div className="dialog__head">
          <span className="dialog__icon dialog__icon--accent">
            <Pencil aria-hidden="true" />
          </span>
          <div>
            <div className="dialog__title" id="ep-title">
              Edit provider
            </div>
            <div className="dialog__desc">Rename or change the base URL.</div>
          </div>
        </div>
        <div className="dialog__body stack" style={{ gap: 12 }}>
          <Field label="Name" htmlFor="ep-name">
            <Input id="ep-name" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Base URL" htmlFor="ep-origin" helper="Trailing slash is stripped.">
            <Input id="ep-origin" mono value={origin} onChange={(e) => setOrigin(e.target.value)} />
          </Field>
          {error ? <span className="field" style={{ color: "var(--danger)" }}>{error}</span> : null}
        </div>
        <div className="dialog__foot">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Save changes
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function ReplaceKeyDialog({
  open,
  onClose,
  providerName,
  busy,
  onSave,
}: {
  open: boolean;
  onClose: () => void;
  providerName: string | null;
  busy?: boolean;
  onSave: (secret: string) => Promise<void>;
}) {
  const [secret, setSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSecret("");
      setError(null);
    }
  }, [open]);

  const submit = async () => {
    const s = secret.trim();
    if (!s) {
      setError("Key is empty after trim.");
      return;
    }
    setError(null);
    await onSave(s);
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy="rk-title">
      <div className="dialog">
        <div className="dialog__head">
          <span className="dialog__icon dialog__icon--accent">
            <KeyRound aria-hidden="true" />
          </span>
          <div>
            <div className="dialog__title" id="rk-title">
              {providerName ? `Replace key — ${providerName}` : "Replace key"}
            </div>
            <div className="dialog__desc">Write-only — the current key is never shown.</div>
          </div>
        </div>
        <div className="dialog__body">
          <Field
            label="New API key"
            htmlFor="rk-key"
            helper="Stored locally (0600), never sent to the browser, never echoed."
            error={error ?? undefined}
          >
            <PasswordInput
              id="rk-key"
              value={secret}
              onChange={setSecret}
              placeholder="sk-…"
              autoFocus
            />
          </Field>
        </div>
        <div className="dialog__foot">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Save key
          </Button>
        </div>
      </div>
    </Modal>
  );
}
