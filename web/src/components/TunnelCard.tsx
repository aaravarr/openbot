import { useState } from "react";
import { Copy, Globe, Info, RefreshCw } from "lucide-react";
import { publicTunnelUrl } from "../lib/tunnel-url";
import { useApp, useBoxState } from "../store";
import { ConfirmDialog } from "./overlays";
import { QrCode } from "./QrCode";
import { Badge, Button, Notice } from "./ui";

/**
 * Phone access (Cloudflare quick tunnel). Moved off the Dashboard so the
 * Dashboard stays a status page; behaviour and toast copy are unchanged.
 */
export function TunnelCard() {
  const state = useBoxState();
  const { save } = useApp();
  const [confirm, setConfirm] = useState<"start" | "stop" | null>(null);
  const [busy, setBusy] = useState(false);

  const tunnel = state.snapshot.tunnel;
  const live = tunnel.kind === "cloudflare-quick";
  const href = live ? publicTunnelUrl(tunnel.url) : "";

  const run = async (expose: "cloudflare" | "off", title: string, message: string) => {
    setBusy(true);
    try {
      await save({ kind: "set-expose", expose }, { successTitle: title, successMessage: message });
    } catch {
      /* the store already showed the failure toast */
    } finally {
      setBusy(false);
    }
  };

  const confirmAction = async () => {
    const action = confirm;
    setConfirm(null);
    if (action === "start") {
      await run("cloudflare", "Tunnel starting", "Scan the QR from your phone once the URL appears.");
    } else if (action === "stop") {
      await run("off", "Tunnel stopped", "The console is reachable only from this Computer.");
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      <section className="card col-12" aria-labelledby="h-tunnel">
        <div className="card__head">
          <span className="card__label" id="h-tunnel">
            Phone access
          </span>
          {live ? <Badge tone="success">Live</Badge> : tunnel.kind === "error" ? <Badge tone="danger">Error</Badge> : <Badge>Off</Badge>}
        </div>
        <div className="card__body stack qr-body" style={{ gap: 12 }}>
          {live ? (
            <>
              <div className="tunnel-url tunnel-url--centred">
                <Globe style={{ color: "var(--muted)", width: 15, height: 15, flex: "none" }} aria-hidden="true" />
                <span className="url">{href}</span>
              </div>
              <Button variant="secondary-sm" icon={Copy} onClick={() => void copy(href)}>
                Copy URL
              </Button>
              <QrCode value={href} label="QR code for the public URL" />
              <Notice tone="warn" icon={Info}>
                Anyone with this URL can open this console. Keys stay on the Computer.
              </Notice>
              <div className="row gap-2">
                <Button
                  variant="secondary-sm"
                  icon={RefreshCw}
                  loading={busy}
                  onClick={() => void run("cloudflare", "Tunnel refreshed", "A fresh public URL was minted.")}
                >
                  Refresh URL
                </Button>
                <Button variant="ghost-danger" onClick={() => setConfirm("stop")}>
                  Stop
                </Button>
              </div>
            </>
          ) : tunnel.kind === "error" ? (
            <>
              <Notice tone="danger" icon={Info}>
                {tunnel.message || "Tunnel failed."}
              </Notice>
              <Button
                variant="secondary"
                icon={RefreshCw}
                loading={busy}
                onClick={() => void run("cloudflare", "Tunnel starting", "Scan the QR from your phone once the URL appears.")}
              >
                Retry
              </Button>
            </>
          ) : (
            <>
              <p style={{ color: "var(--body)" }}>
                Expose this console to your phone over a temporary Cloudflare URL. The first start downloads cloudflared.
              </p>
              <div>
                <Button variant="ink" loading={busy} onClick={() => setConfirm("start")}>
                  Start tunnel
                </Button>
              </div>
            </>
          )}
        </div>
      </section>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => void confirmAction()}
        title={confirm === "start" ? "Start the tunnel?" : "Stop the tunnel?"}
        description={
          confirm === "start"
            ? "Anyone with the public URL can open this console. Keys stay on the Computer."
            : "The public URL stops working immediately. Anyone using it loses access."
        }
        confirmLabel={confirm === "start" ? "Start tunnel" : "Stop tunnel"}
        busy={busy}
      />
    </>
  );
}
