import type { TunnelState } from "./api";

export function PhoneAccess({
  tunnel,
  busy,
  onExpose,
}: {
  tunnel: TunnelState;
  busy: boolean;
  onExpose: (expose: "cloudflare" | "off") => void;
}) {
  return (
    <div className="phone-access">
      <p className="section-label">Phone</p>
      <p className="fine">
        This Computer: <span className="mono">http://127.0.0.1:9280</span>
      </p>
      {tunnel.kind === "cloudflare-quick" ? (
        <>
          <p className="fine">
            Cloudflare: <span className="mono">{tunnel.url}</span>
          </p>
          {tunnel.qr ? <pre className="qr" aria-label="QR code for the phone URL">{tunnel.qr}</pre> : null}
          <p className="hint-soft">Anyone with that URL can open the control page. Keys stay on this Computer.</p>
          <p className="hint-soft">If that URL stops working, refresh it here.</p>
          <div>
            <button type="button" className="button-tertiary" disabled={busy} onClick={() => onExpose("cloudflare")}>
              Refresh URL
            </button>
          </div>
          <div>
            <button type="button" className="button-tertiary" disabled={busy} onClick={() => onExpose("off")}>
              Stop Cloudflare Tunnel
            </button>
          </div>
        </>
      ) : tunnel.kind === "error" ? (
        <>
          <p className="fine error">{tunnel.message}</p>
          <button type="button" className="button-tertiary" disabled={busy} onClick={() => onExpose("cloudflare")}>
            Try Cloudflare Tunnel again
          </button>
        </>
      ) : (
        <button type="button" className="button-tertiary" disabled={busy} onClick={() => onExpose("cloudflare")}>
          Open from phone with Cloudflare Tunnel
        </button>
      )}
    </div>
  );
}
