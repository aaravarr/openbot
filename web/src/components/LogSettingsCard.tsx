import { useEffect, useState } from "react";
import { Settings2, ShieldCheck } from "lucide-react";
import { saveLogSettings } from "../api/client";
import type { LogSettings } from "../api/types";
import { useApp, useBoxState } from "../store";
import { NumberInput } from "./fields";
import { Button, Notice } from "./ui";

/**
 * Recording settings, moved off the Logs page. The Logs page keeps browsing,
 * filtering, and cleanup; this card owns the write.
 */
export function LogSettingsCard() {
  const state = useBoxState();
  const { pushToast, refresh } = useApp();
  const [settings, setSettings] = useState<LogSettings | null>(state.logSettings ?? null);
  const [recording, setRecording] = useState(state.logSettings?.loggingEnabled ?? false);
  const [bodiesAll, setBodiesAll] = useState(state.logSettings?.logBodies ?? false);
  const [retention, setRetention] = useState<number | null>(state.logSettings?.logRetentionDays ?? 7);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty =
    settings !== null &&
    (recording !== settings.loggingEnabled ||
      bodiesAll !== settings.logBodies ||
      retention !== settings.logRetentionDays);

  // Follow the store, but never clobber an unsaved edit with the 30s poll.
  useEffect(() => {
    const next = state.logSettings;
    if (!next || dirty) return;
    setSettings(next);
    setRecording(next.loggingEnabled);
    setBodiesAll(next.logBodies);
    setRetention(next.logRetentionDays);
  }, [state.logSettings, dirty]);

  const save = async () => {
    setError(null);
    if (retention === null || retention < 1 || retention > 365 || !Number.isInteger(retention)) {
      setError("Retention must be a whole number of days between 1 and 365.");
      return;
    }
    setSaving(true);
    try {
      const saved = await saveLogSettings({
        loggingEnabled: recording,
        logBodies: bodiesAll,
        logBodiesOnError: !bodiesAll,
        logRetentionDays: retention,
      });
      setSettings(saved);
      if (saved.wrapError) {
        setError(`Recording saved, but the host tap could not be applied (${saved.wrapError}).`);
        pushToast("error", "Settings saved", `Recording is ${recording ? "on" : "off"} — the host tap could not be applied (${saved.wrapError}).`);
      } else if (saved.wrapBytesChanged) {
        pushToast("info", "Settings saved", recording
          ? "Official Grok capture is on. The host restarted; send a new message to record a turn."
          : "Official tap removed. Chat is stock Grok again.");
      } else {
        pushToast("success", "Settings saved", `Recording is ${recording ? "on" : "off"} — bodies kept ${bodiesAll ? "for all requests" : "on errors only"}, ${retention}-day retention.`);
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save settings.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card col-12" aria-labelledby="h-log-settings">
      <div className="card__head">
        <span className="card__label" id="h-log-settings">
          <Settings2 style={{ width: 13, height: 13 }} aria-hidden="true" />
          Recording settings
        </span>
      </div>
      <div className="card__body stack" style={{ gap: 14 }}>
        <div className="row row--between wrap gap-3">
          <label className="switch">
            <input type="checkbox" role="switch" checked={recording} disabled={saving} onChange={(e) => setRecording(e.target.checked)} />
            <span className="switch__track"><span className="switch__thumb" /></span>
            <span className="switch__label">Recording</span>
          </label>
          <div className="row gap-3" style={{ fontSize: 13 }}>
            <span style={{ color: "var(--muted)" }}>Bodies:</span>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input type="radio" name="bodies" checked={!bodiesAll} disabled={saving} onChange={() => setBodiesAll(false)} style={{ accentColor: "var(--primary)" }} />
              Errors only
            </label>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
              <input type="radio" name="bodies" checked={bodiesAll} disabled={saving} onChange={() => setBodiesAll(true)} style={{ accentColor: "var(--primary)" }} />
              All
            </label>
          </div>
          <div className="row gap-2">
            <span style={{ color: "var(--muted)", fontSize: 13 }}>Retention</span>
            <NumberInput value={retention} onChange={setRetention} min={1} max={365} className="input--mono" ariaLabel="Retention days" />
            <span style={{ color: "var(--muted)", fontSize: 13 }}>days</span>
          </div>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save settings
          </Button>
        </div>
        {error ? <span className="field" role="alert" style={{ color: "var(--danger)" }}>{error}</span> : null}
        <div className="notice notice--info">
          <ShieldCheck aria-hidden="true" />
          <span className="text">Keys are always redacted server-side; bodies default off.</span>
        </div>
      </div>
    </section>
  );
}
