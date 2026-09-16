import { useCallback, useEffect, useState } from "react";
import { Info, RefreshCw, TriangleAlert } from "lucide-react";
import { ApiError, getDeliverySettings, saveDeliverySettings } from "../api/client";
import type { DeliveryMode, DeliverySettings } from "../api/types";
import { useApp, useBoxState } from "../store";
import { Badge, Button, Notice, Switch } from "./ui";

/**
 * Delivery follow-up ("injection hardening").
 *
 * One switch, and that is the whole card: off sends nothing extra, on means the
 * enforcing mode with every layer armed. Saving writes the sand-data config
 * file the hop hot-reads, so nothing here bounces the host or the hop — the next
 * request picks the change up. `dry-run` stays reachable through that file for
 * operators (skills/openbot-config/reference.md); the card no longer offers it.
 */

/** The card's two product-copy strings, kept verbatim as constants. */
const ABOUT =
  "Grok Bot only shows the user what the model delivers with a SendToUser call. When a custom turn ends without one, the result never reaches them. This follow-up extends the built-in reminder: it nudges the model to deliver its result before the turn closes, so fewer replies are lost.";

const SUBLINE =
  "Experimental and off by default. Turn it on and save — it applies from the next message, and nothing extra is sent while it is off.";

/** Everything the switch arms. The payload runs a layer only while its layer object is present. */
const ALL_LAYERS = { l1: true, l2: true, l3: true } as const;

/** The switch is the whole draft: on means enforce with every layer armed. */
function draftOf(settings: DeliverySettings): boolean {
  return settings.mode !== "off";
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
      ? "Off: nothing extra is sent."
      : "On: a follow-up nudges the model when a turn ends without delivering.";
  return saved.envOverride && saved.mode !== requested
    ? `${base} An environment variable still pins the mode.`
    : base;
}

export function DeliveryCard() {
  const { pushToast } = useApp();
  const state = useBoxState();
  const custom = state.snapshot.alignment.desired === "custom";
  const [data, setData] = useState<{ server: DeliverySettings; draft: boolean } | null>(null);
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
          <Badge tone="info">Experimental</Badge>
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

  const { server, draft: enabled } = data;
  const requested: DeliveryMode = enabled ? "enforce" : "off";
  // The server state is only "what the switch claims" when the mode matches and,
  // for an enabled mode, every layer the switch stands for is actually armed. A
  // config file that is a bare `{"mode":"enforce"}` arms nothing, so the card
  // reads as dirty and one Save arms it instead of dead-ending on a disabled
  // button.
  const dirty =
    requested !== server.mode ||
    (requested === "enforce" && !(server.layers.l1 && server.layers.l2 && server.layers.l3));

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      // Saving an enabled mode arms every layer the switch stands for: the file
      // only runs a layer whose object is present, so a layer left out of the
      // file (or turned off by hand) stays dead. Saving `off` sends no layers.
      const saved = await saveDeliverySettings(requested, requested === "off" ? undefined : ALL_LAYERS);
      setData({ server: saved, draft: draftOf(saved) });
      pushToast("success", "Delivery follow-up saved", describeSaved(saved, requested));
    } catch (err) {
      // The switch is optimistic. A failed write rolls the draft back to the mode
      // the server confirmed instead of leaving the page claiming a mode the hop
      // is not running.
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
        <Badge tone="info">Experimental</Badge>
      </div>
      <div className="card__body stack" style={{ gap: 16 }}>
        <p style={{ color: "var(--body)", margin: 0 }}>{ABOUT}</p>

        <div className="stack" style={{ gap: 6 }}>
          <Switch
            checked={enabled}
            disabled={saving}
            onChange={(next) => setData({ server, draft: next })}
            label="Enable the delivery follow-up"
          />
          <span className="delivery-card__hint">{SUBLINE}</span>
        </div>

        {!custom ? (
          <Notice tone="info" icon={Info}>
            This setting only applies to custom turns.
          </Notice>
        ) : null}

        {server.envOverride ? (
          <Notice tone="warn" icon={TriangleAlert}>
            An environment variable pins the delivery follow-up on this Computer, so saving here cannot change what
            runs until it is unset.
          </Notice>
        ) : null}

        <div className="delivery-card__actions">
          <Button variant="primary" loading={saving} disabled={!dirty} onClick={() => void save()}>
            Save
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
