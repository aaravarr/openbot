import { useCallback, useEffect, useState } from "react";
import { Info, RefreshCw, TriangleAlert } from "lucide-react";
import { ApiError, getDeliverySettings, saveDeliverySettings } from "../api/client";
import type { DeliveryMode, DeliverySettings } from "../api/types";
import { useApp, useBoxState } from "../store";
import { Badge, Button, Notice, Switch } from "./ui";

/**
 * Delivery follow-up ("injection hardening") switch.
 *
 * The switch owns off/on; the radios pick the depth once it is on. Saving writes
 * the sand-data config file that the hop hot-reads, so nothing here bounces the
 * host or the hop: the next request picks the change up.
 */

type DeliveryChoice = Exclude<DeliveryMode, "off">;

type DeliveryDraft = { enabled: boolean; mode: DeliveryChoice };

const MODE_CHOICES: { value: DeliveryChoice; label: string; hint: string; recommended?: boolean }[] = [
  {
    value: "dry-run",
    label: "Observe only",
    hint: "Records what a follow-up would do. Nothing extra is sent.",
    recommended: true,
  },
  {
    value: "enforce",
    label: "Send the follow-up",
    hint: "Sends one extra request so the result actually reaches the user.",
  },
];

function draftOf(settings: DeliverySettings): DeliveryDraft {
  return {
    enabled: settings.mode !== "off",
    mode: settings.mode === "off" ? "dry-run" : settings.mode,
  };
}

function modeLabel(mode: DeliveryMode): string {
  if (mode === "dry-run") return "Dry run";
  if (mode === "enforce") return "Enforce";
  return "Off";
}

function sourcePhrase(source: DeliverySettings["source"]): string {
  if (source === "env") return "pinned by an environment variable";
  if (source === "file") return "from the config file";
  return "default, no config file yet";
}

function layerSummary(layers: DeliverySettings["layers"]): string {
  return (["l1", "l2", "l3"] as const).map((name) => `${name.toUpperCase()} ${layers[name] ? "on" : "off"}`).join(" · ");
}

/**
 * One plain sentence for a save that never reached the service. `fetch` rejects
 * with a bare `TypeError` and the client re-throws it as an `ApiError` whose
 * status is 0; either way the browser's own "Failed to fetch" is not something to
 * show the user. A server that did answer keeps its own message — a 400 carries
 * the useful text ("mode must be one of off, dry-run, enforce").
 */
function saveFailureMessage(err: unknown): string {
  const unreachable = "Could not reach the OpenBot service on this Computer. The setting was not saved.";
  if (err instanceof TypeError) return unreachable;
  if (err instanceof ApiError) return err.status === 0 ? unreachable : err.message;
  return err instanceof Error && err.message ? err.message : unreachable;
}

/** Leads with what the user just asked for; the env note reports what is in force. */
function describeSaved(saved: DeliverySettings, requested: DeliveryMode): string {
  const base =
    requested === "off"
      ? "Delivery follow-up is off. The file keeps its layer tuning."
      : requested === "dry-run"
        ? "Dry run: follow-ups are recorded and nothing extra is sent."
        : "Enforce: a follow-up is sent when a turn ends without delivering.";
  return saved.envOverride && saved.mode !== requested
    ? `${base} An environment variable still pins the effective mode to ${modeLabel(saved.mode)}.`
    : base;
}

/** Everything the switch can arm. The payload runs a layer only while its layer object is present. */
const ALL_LAYERS = { l1: true, l2: true, l3: true } as const;

export function DeliveryCard() {
  const { pushToast } = useApp();
  const state = useBoxState();
  const custom = state.snapshot.alignment.desired === "custom";
  const [data, setData] = useState<{ server: DeliverySettings; draft: DeliveryDraft } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getDeliverySettings();
      setData({ server: next, draft: draftOf(next) });
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load delivery settings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) {
    return (
      <section className="card col-12" aria-labelledby="h-delivery">
        <div className="card__head">
          <span className="card__label" id="h-delivery">
            Delivery follow-up
          </span>
        </div>
        <div className="card__body stack" style={{ gap: 12 }}>
          {loadError ? (
            <>
              <Notice tone="danger" icon={TriangleAlert}>
                {loadError}
              </Notice>
              <div className="row gap-2">
                <Button variant="secondary" icon={RefreshCw} loading={loading} onClick={() => void load()}>
                  Retry
                </Button>
              </div>
            </>
          ) : (
            <p style={{ color: "var(--muted)", margin: 0, fontSize: 13 }}>Checking…</p>
          )}
        </div>
      </section>
    );
  }

  const { server, draft } = data;
  const requested: DeliveryMode = draft.enabled ? draft.mode : "off";
  // The server state is only "what the card claims" when the mode matches and,
  // for an enabled mode, every layer the card displays is actually armed. A
  // config file that is a bare `{"mode":"enforce"}` arms nothing, so the card
  // reads as dirty and one Save arms it instead of dead-ending on a disabled
  // button.
  const dirty =
    requested !== server.mode ||
    (requested !== "off" && !(server.layers.l1 && server.layers.l2 && server.layers.l3));
  const badgeTone = !draft.enabled ? undefined : draft.mode === "enforce" ? "accent" : "info";

  const edit = (next: DeliveryDraft) => setData({ server, draft: next });

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // Saving an enabled mode arms every layer the card displays: the file only
      // runs a layer whose object is present, so a layer left out of the file
      // (or turned off by hand) stays dead. Saving `off` sends no layers.
      const saved = await saveDeliverySettings(requested, requested === "off" ? undefined : ALL_LAYERS);
      setData({ server: saved, draft: draftOf(saved) });
      pushToast("success", "Delivery follow-up saved", describeSaved(saved, requested));
    } catch (err) {
      // The switch and radios are optimistic. A failed write rolls the draft
      // back to the last mode the server confirmed instead of leaving the page
      // claiming a mode the hop is not running.
      const message = saveFailureMessage(err);
      setData({ server, draft: draftOf(server) });
      setSaveError(message);
      pushToast("error", "Delivery follow-up not saved", message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card col-12" aria-labelledby="h-delivery">
      <div className="card__head">
        <span className="card__label" id="h-delivery">
          Delivery follow-up
        </span>
        <Badge tone={badgeTone}>{draft.enabled ? modeLabel(draft.mode) : "Off"}</Badge>
      </div>
      <div className="card__body stack" style={{ gap: 16 }}>
        <p style={{ color: "var(--body)", margin: 0 }}>
          Grok Bot only shows the user what the model delivers with a SendToUser tool call. When a custom turn ends
          without one, the result never reaches them. This follow-up nudges the model to deliver it.
        </p>

        {!custom ? (
          <Notice tone="info" icon={Info}>
            This setting only applies to custom turns. Stock xAI turns never reach the hop, so nothing here changes
            them.
          </Notice>
        ) : null}

        <div className="stack" style={{ gap: 6 }}>
          <Switch
            checked={draft.enabled}
            disabled={saving}
            onChange={(next) => edit({ enabled: next, mode: draft.mode })}
            label="Enable delivery follow-up"
          />
          <span style={{ color: "var(--muted)", fontSize: 12 }}>
            Off by default. Nothing extra is sent until you turn this on and save.
          </span>
          {draft.enabled ? (
            <span style={{ color: "var(--muted)", fontSize: 12 }}>
              Turning this on and saving arms all three layers (L1 · L2 · L3) — the file only runs a layer while
              its block is present, so one turned off by hand comes back on.
            </span>
          ) : null}
        </div>

        {draft.enabled ? (
          <div className="stack" style={{ gap: 8 }} role="radiogroup" aria-label="Follow-up mode">
            {MODE_CHOICES.map((choice) => (
              <label key={choice.value} style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer" }}>
                <input
                  type="radio"
                  name="delivery-mode"
                  value={choice.value}
                  checked={draft.mode === choice.value}
                  disabled={saving}
                  onChange={() => edit({ enabled: true, mode: choice.value })}
                  style={{ accentColor: "var(--primary)", marginTop: 3 }}
                />
                <span className="stack" style={{ gap: 2 }}>
                  <span className="row gap-2">
                    <span style={{ fontWeight: 500 }}>{choice.label}</span>
                    {choice.recommended ? <Badge>Recommended</Badge> : null}
                  </span>
                  <span style={{ color: "var(--muted)", fontSize: 12 }}>{choice.hint}</span>
                </span>
              </label>
            ))}
          </div>
        ) : null}

        <div className="rule-microcopy">
          <Info aria-hidden="true" />
          <span>
            Changes apply from the next request with no restart, and any failure releases the turn normally — a failed
            follow-up never leaves the chat stuck.
          </span>
        </div>

        <div className="def-grid">
          <span className="k">Effective now</span>
          <span className="v">{modeLabel(server.mode)} — {sourcePhrase(server.source)}</span>
          <span className="k">Config file</span>
          <span className="v mono">{server.exists ? server.path : `${server.path} (not written yet)`}</span>
          <span className="k">Layers</span>
          <span className="v">{layerSummary(server.layers)}</span>
          <span className="k">Extra runs</span>
          <span className="v">up to {server.maxAdditionalRuns} follow-up {server.maxAdditionalRuns === 1 ? "request" : "requests"}</span>
        </div>

        {server.envOverride ? (
          <Notice tone="warn" icon={TriangleAlert}>
            An environment variable pins the mode to <strong>{modeLabel(server.mode)}</strong>, so the file cannot win
            while it is set. Saving is still allowed.
          </Notice>
        ) : null}

        <div className="row row--between wrap gap-3">
          <span style={{ color: "var(--muted)", fontSize: 12 }}>{dirty ? "Unsaved changes." : "Saved."}</span>
          <Button variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
            Save delivery follow-up
          </Button>
        </div>
        {saveError ? (
          <span className="field" role="alert" style={{ color: "var(--danger)" }}>
            {saveError}
          </span>
        ) : null}
      </div>
    </section>
  );
}
