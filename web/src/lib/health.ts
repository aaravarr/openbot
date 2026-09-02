import type { BoxState } from "../api/types";
import type { DotState } from "../components/ui";

export type HealthItem = { word: string; value: string; state: DotState; label: string; fault?: string };

const HEALTH_RANK: Record<DotState, number> = { fault: 3, warn: 2, ok: 1, off: 0 };

/** Worst health item for the condensed mobile status strip (fault > warn > ok). */
export function worstHealth(items: HealthItem[]): HealthItem | undefined {
  if (!items.length) return undefined;
  return items.reduce((worst, h) => (HEALTH_RANK[h.state] > HEALTH_RANK[worst.state] ? h : worst));
}

export function deriveHealth(state: BoxState, service: { ok: boolean; latencyMs?: number }): HealthItem[] {
  const host = state.snapshot.host;
  const port = state.snapshot.hopListen;
  const wrap = state.snapshot.wrap;
  const align = state.snapshot.alignment;

  const hostItem: HealthItem =
    host.kind === "running-owned"
      ? { word: "Host process", value: `running · pid ${host.pid}`, state: "ok", label: "Host: running" }
      : { word: "Host process", value: "absent", state: "fault", label: "Host: absent", fault: "Grok Bot host process is not running." };

  const portItem: HealthItem =
    port.kind === "ours"
      ? { word: "Port 9280", value: `ours · pid ${port.pid}`, state: "ok", label: "Port 9280: ours" }
      : port.kind === "absent"
        ? { word: "Port 9280", value: "absent", state: "warn", label: "Port 9280: absent" }
        : { word: "Port 9280", value: "foreign", state: "fault", label: "Port 9280: foreign", fault: "A foreign process owns port 9280 — stop it before switching modes." };

  const wrapLabel =
    wrap.kind === "stock-unmarked"
      ? "stock"
      : wrap.kind === "openbot-marked"
        ? "openbot"
        : wrap.kind === "foreign-opengrok"
          ? "foreign"
          : "unknown";
  const wrapFault =
    wrap.kind === "foreign-opengrok"
      ? "A foreign opengrok wrap is present."
      : wrap.kind !== "openbot-marked" && wrap.kind !== "stock-unmarked"
        ? "Unrecognized host layout."
        : undefined;
  const wrapItem: HealthItem = {
    word: "Wrap",
    value: wrapLabel,
    state: wrapFault ? "fault" : wrap.kind === "openbot-marked" ? "ok" : "off",
    label: `Wrap: ${wrapLabel}`,
    fault: wrapFault,
  };

  const alignFault =
    align.kind === "needs-reinstall" ? "Host file is stock but custom is desired — re-wrap to fix." : undefined;
  const alignItem: HealthItem = {
    word: "Alignment",
    value: align.kind,
    state: alignFault ? "fault" : "ok",
    label: `Alignment: ${align.kind}`,
    fault: alignFault,
  };

  const serviceItem: HealthItem = service.ok
    ? {
        word: "Service",
        value: service.latencyMs !== undefined ? `ok · ${service.latencyMs}ms` : "ok",
        state: "ok",
        label: "Service: ok",
      }
    : { word: "Service", value: "unreachable", state: "fault", label: "Service: unreachable", fault: "Can't reach the openbot service." };

  return [hostItem, portItem, wrapItem, alignItem, serviceItem];
}
