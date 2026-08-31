import { LOOPBACK, SERVICE_PORT, type Snapshot, type TunnelObserved } from "../domain/types.ts";
import { renderQrAscii } from "../qrcode.ts";
import type { ReconcileResult } from "../supervisor/reconcile.ts";

export function controlUrl(): string {
  return `http://${LOOPBACK}:${String(SERVICE_PORT)}`;
}

function printTunnel(tunnel: TunnelObserved | undefined): void {
  const internal = controlUrl();
  if (!tunnel || tunnel.kind === "off") {
    console.log("");
    console.log("  This Computer     " + internal);
    console.log("");
    console.log("Open that address in the Computer browser.");
    console.log("From a phone later: openbot tunnel on");
    return;
  }
  if (tunnel.kind === "error") {
    console.log("");
    console.log("  This Computer     " + internal);
    console.log("");
    console.log("Cloudflare Tunnel did not start:");
    console.log("  " + tunnel.message);
    console.log("The local page still works. Try again with: openbot tunnel on");
    return;
  }
  console.log("");
  console.log("Scan from your phone:");
  console.log("");
  try {
    console.log(renderQrAscii(tunnel.url));
  } catch {
    console.log("(QR skipped — open the phone URL in a browser.)");
  }
  console.log("");
  console.log("  This Computer     " + internal);
  console.log("  Phone             " + tunnel.url);
  console.log("");
  console.log("Anyone with the phone URL can open the control page. Keys stay on this Computer.");
  console.log("");
  console.log("Cloudflare Tunnel is running in the background.");
  console.log("Stop it with: openbot tunnel off");
}

export function printReady(snapshot: Snapshot, heading = "OpenBot is ready."): void {
  console.log(heading);
  printTunnel(snapshot.tunnel);
}

export function printRefused(result: Extract<ReconcileResult, { kind: "refused" }>): void {
  const err = result.error;
  if (err.kind === "host-missing") {
    console.error(`OpenBot: missing Grok Bot host file ${err.path}`);
    return;
  }
  if (err.kind === "foreign-ui" || err.kind === "foreign-hop") {
    console.error("OpenBot: port 9280 is already in use by another process. It will not take it over.");
    return;
  }
  if (err.kind === "foreign-opengrok") {
    console.error("OpenBot: another overlay is still attached to Grok Bot. It was left alone.");
    return;
  }
  if (err.kind === "listen-failed") {
    console.error(`OpenBot: could not listen on port ${String(err.port)}.`);
    return;
  }
  if (err.kind === "syntax-check-failed") {
    console.error("OpenBot: wrap syntax check failed.");
    console.error(err.stderr);
    return;
  }
  console.error(`OpenBot: ${err.kind}${err.kind === "census-refused" ? ` (${err.reason})` : ""}`);
}

export function printResult(result: ReconcileResult, json: boolean): void {
  if (json) {
    if (result.kind === "ok") {
      console.log(JSON.stringify({ ok: true, wrapBytesChanged: result.wrapBytesChanged, snapshot: result.snapshot }, null, 2));
      return;
    }
    console.error(JSON.stringify(result, null, 2));
    return;
  }
  if (result.kind === "ok") {
    printReady(result.snapshot);
    return;
  }
  printRefused(result);
}

export function printStatus(snapshot: Snapshot, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  const wrap =
    snapshot.wrap.kind === "openbot-marked"
      ? "custom model"
      : snapshot.wrap.kind === "stock-unmarked"
        ? "official Grok"
        : snapshot.wrap.kind;
  console.log(`Chat: ${wrap}`);
  printTunnel(snapshot.tunnel);
}
