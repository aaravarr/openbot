import { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Copy,
  Globe,
  Info,
  RefreshCw,
  Rocket,
  Zap,
} from "lucide-react";
import { hasKey, listLogs, modelById, providerById } from "../api/client";
import type { LogRecord, Model, SaveResult } from "../api/types";
import { LogChannelPair } from "../components/LogChannel";
import { asLogChannels, formatLatency, formatTime, formatTokens, labelReasoning } from "../lib/format";
import {
  pairChannels,
  pairKey,
  pairLatency,
  pairLogRows,
  pairModel,
  pairOpenId,
  pairStartedAt,
  pairStatus,
} from "../lib/pair-logs";
import { deriveHealth } from "../lib/health";
import { navigate } from "../lib/router";
import { publicTunnelUrl } from "../lib/tunnel-url";
import { useApp, useBoxState } from "../store";
import { Listbox, type ListboxGroup } from "../components/Listbox";
import { QrCode } from "../components/QrCode";
import { ConfirmDialog } from "../components/overlays";
import {
  Badge,
  Button,
  EmptyState,
  HealthDot,
  ModePill,
  Notice,
  ParamChip,
  StatusPill,
} from "../components/ui";

function usedMessage(result: SaveResult): string {
  const model = result.models.find((m) => m.id === result.activeModelId);
  const base = model
    ? `Grok Bot will use ${model.slug}${model.activeReasoning && model.activeReasoning !== "default" ? ` (${labelReasoning(model.activeReasoning)})` : ""} on the next message.`
    : "Model switched.";
  return result.wrapBytesChanged ? `${base} Grok Bot was restarted to apply the wrap.` : base;
}

export function Dashboard() {
  const state = useBoxState();
  const { save, service, refresh } = useApp();
  const [confirmOfficial, setConfirmOfficial] = useState(false);
  const [confirmTunnel, setConfirmTunnel] = useState<"start" | "stop" | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [recent, setRecent] = useState<LogRecord[]>([]);

  const custom = state.snapshot.alignment.desired === "custom";
  const active = modelById(state, state.activeModelId);
  const activeProvider = active ? providerById(state, active.providerId) : undefined;
  const tunnel = state.snapshot.tunnel;
  const health = deriveHealth(state, service);
  const empty = state.providers.length === 0;
  const tunnelHref = tunnel.kind === "cloudflare-quick" ? publicTunnelUrl(tunnel.url) : "";
  const recentPairs = useMemo(() => pairLogRows(recent).slice(0, 5), [recent]);

  useEffect(() => {
    let alive = true;
    listLogs({ pageSize: 12 })
      .then((list) => {
        if (alive) setRecent(list.items);
      })
      .catch(() => {
        /* non-critical */
      });
    return () => {
      alive = false;
    };
  }, [state.activeModelId, state.snapshot.alignment.desired]);

  const groups: ListboxGroup[] = useMemo(() => {
    return state.providers.map((p) => ({
      label: p.name,
      options: state.models
        .filter((m) => m.providerId === p.id)
        .map((m) => ({
          value: m.id,
          label: m.slug,
          sublabel: hasKey(state, p.id) ? undefined : "no key",
          badges: (
            <>
              {formatTokens(m.contextTokens) !== "—" ? <span className="badge">{formatTokens(m.contextTokens)}</span> : null}
              {!hasKey(state, p.id) ? <span className="badge badge--warning">No key</span> : null}
            </>
          ),
        })),
    }));
  }, [state]);

  const run = async (
    id: string,
    command: Parameters<typeof save>[0],
    opts: { title: string; message?: string | ((r: SaveResult) => string) },
  ) => {
    setBusy(id);
    try {
      await save(command, { successTitle: opts.title, successMessage: opts.message });
    } catch {
      /* toast already shown */
    } finally {
      setBusy(null);
    }
  };

  const useModel = async (model: Model, reasoning?: string) => {
    if (!hasKey(state, model.providerId)) {
      navigate({ kind: "models", providerId: model.providerId });
      return;
    }
    await run(
      "use",
      reasoning !== undefined ? { kind: "use-model", modelId: model.id, reasoning } : { kind: "use-model", modelId: model.id },
      { title: "Model switched", message: usedMessage },
    );
  };

  const setReasoning = async (level: string) => {
    if (!active) return;
    if (level === active.activeReasoning) return;
    await useModel(active, level);
  };

  const switchToOfficial = async () => {
    setConfirmOfficial(false);
    await run("official", { kind: "official" }, {
      title: "Switched to Official",
      message: "Grok Bot will use stock xAI on the next message.",
    });
  };

  const tunnelAction = async () => {
    const action = confirmTunnel;
    setConfirmTunnel(null);
    if (action === "start") {
      await run("tunnel", { kind: "set-expose", expose: "cloudflare" }, {
        title: "Tunnel starting",
        message: "Scan the QR from your phone once the URL appears.",
      });
    } else if (action === "stop") {
      await run("tunnel", { kind: "set-expose", expose: "off" }, {
        title: "Tunnel stopped",
        message: "The console is reachable only from this Computer.",
      });
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* ignore */
    }
  };

  if (empty) {
    return (
      <section className="card card--pad" aria-label="Setup">
        <EmptyState
          icon={Rocket}
          title="Set up your first provider"
          body="Connect an OpenAI-compatible provider so Grok Bot can chat through it."
          action={
            <Button variant="primary" onClick={() => navigate({ kind: "setup" })}>
              Set up a provider
            </Button>
          }
        />
      </section>
    );
  }

  const tunnelLive = tunnel.kind === "cloudflare-quick";

  return (
    <>
      <div className="page-title-row">
        <h1>Dashboard</h1>
        <span className="sub">Is my box working? What is active right now?</span>
      </div>

      <div className="grid grid--12">
        {/* Mode hero */}
        <section className="card card--pad col-8" aria-labelledby="h-mode">
          <div className="row row--between" style={{ marginBottom: 16 }}>
            <span className="card__label" id="h-mode">
              Mode
            </span>
            <ModePill mode={custom ? "custom" : "official"} model={active?.slug} />
          </div>

          {custom && active ? (
            <div className="hero-mode">
              <div className="mode-row">
                <span className="hero-model-id">{active.slug}</span>
                <Badge tone="accent" icon={Zap}>
                  Active
                </Badge>
              </div>
              <div className="hero-sub">
                <span>{activeProvider?.name ?? "Unknown provider"}</span>
                {activeProvider && hasKey(state, activeProvider.id) ? (
                  <Badge tone="success">Key saved</Badge>
                ) : (
                  <Badge tone="warning">No API key</Badge>
                )}
                {activeProvider ? <span className="mono wrap-anywhere">{activeProvider.origin}</span> : null}
              </div>

              <div>
                <div className="section-label" style={{ marginBottom: 8 }}>
                  Reasoning level
                </div>
                <div className="row gap-1 wrap">
                  {active.reasoningLevels.map((level) => (
                    <ParamChip
                      key={level}
                      pinned={level === "default"}
                      active={level === active.activeReasoning}
                      disabled={busy !== null}
                      onClick={() => setReasoning(level)}
                    >
                      {labelReasoning(level)}
                    </ParamChip>
                  ))}
                </div>
              </div>

              <div className="rule-microcopy">
                <Info aria-hidden="true" />
                <span>Changes apply to the next new message in Grok Bot. One model is active at a time.</span>
              </div>

              <div className="row gap-2 wrap">
                <Listbox
                  label="Quick model switcher"
                  groups={groups}
                  value={active.id}
                  disabled={busy !== null}
                  onChange={(id) => {
                    const m = state.models.find((x) => x.id === id);
                    if (m) void useModel(m);
                  }}
                />
                <Button variant="ghost-danger" onClick={() => setConfirmOfficial(true)}>
                  Switch to Official Grok
                </Button>
              </div>
            </div>
          ) : custom ? (
            <div className="hero-mode">
              <div className="mode-row">
                <span className="hero-model-id">No model active</span>
              </div>
              <p className="hero-sub" style={{ color: "var(--body)" }}>
                This provider has no models yet — fetch them from the Models page.
              </p>
              <div className="row gap-2">
                <Button variant="secondary" onClick={() => navigate({ kind: "models" })}>
                  Manage models
                </Button>
              </div>
            </div>
          ) : (
            <div className="hero-mode">
              <div className="mode-row">
                <span className="hero-model-id">Official Grok</span>
              </div>
              <p className="hero-sub" style={{ color: "var(--body)" }}>
                {state.models.length
                  ? `Ready to re-enable (last model: ${state.models[0]?.slug ?? "—"}).`
                  : "Chat is running on stock xAI."}
              </p>
              {state.models.length ? (
                <div className="row gap-2">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      const last = state.models[0];
                      if (last) void useModel(last);
                    }}
                  >
                    Re-enable custom
                  </Button>
                  <Button variant="secondary" onClick={() => navigate({ kind: "models" })}>
                    Manage models
                  </Button>
                </div>
              ) : (
                <div className="row gap-2">
                  <Button variant="primary" onClick={() => navigate({ kind: "setup" })}>
                    Set up a provider
                  </Button>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Tunnel */}
        <section className="card col-4" aria-labelledby="h-tunnel">
          <div className="card__head">
            <span className="card__label" id="h-tunnel">
              Phone access
            </span>
            {tunnelLive ? <Badge tone="success">Live</Badge> : tunnel.kind === "error" ? <Badge tone="danger">Error</Badge> : <Badge>Off</Badge>}
          </div>
          <div className="card__body stack" style={{ gap: 12 }}>
            {tunnelLive ? (
              <>
                <div className="tunnel-url">
                  <Globe style={{ color: "var(--muted)", width: 15, height: 15, flex: "none" }} aria-hidden="true" />
                  <span className="url">{tunnelHref}</span>
                </div>
                <Button variant="secondary-sm" icon={Copy} onClick={() => void copy(tunnelHref)}>
                  Copy URL
                </Button>
                <QrCode value={tunnelHref} label="QR code for the public URL" />
                <Notice tone="warn" icon={Info}>
                  Anyone with this URL can open this console. Keys stay on the Computer.
                </Notice>
                <div className="row gap-2">
                  <Button variant="secondary-sm" icon={RefreshCw} loading={busy === "tunnel"} onClick={() => void run("tunnel", { kind: "set-expose", expose: "cloudflare" }, { title: "Tunnel refreshed", message: "A fresh public URL was minted." })}>
                    Refresh URL
                  </Button>
                  <Button variant="ghost-danger" onClick={() => setConfirmTunnel("stop")}>
                    Stop
                  </Button>
                </div>
              </>
            ) : tunnel.kind === "error" ? (
              <>
                <Notice tone="danger" icon={Info}>
                  {tunnel.message || "Tunnel failed."}
                </Notice>
                <Button variant="secondary" icon={RefreshCw} loading={busy === "tunnel"} onClick={() => void run("tunnel", { kind: "set-expose", expose: "cloudflare" }, { title: "Tunnel starting", message: "Scan the QR from your phone once the URL appears." })}>
                  Retry
                </Button>
              </>
            ) : (
              <>
                <p style={{ color: "var(--body)" }}>
                  Expose this console to your phone over a temporary Cloudflare URL. The first start downloads cloudflared.
                </p>
                <Button variant="ink" loading={busy === "tunnel"} onClick={() => setConfirmTunnel("start")}>
                  Start tunnel
                </Button>
              </>
            )}
          </div>
        </section>

        {/* Health strip */}
        <section className="card col-12" aria-labelledby="h-health">
          <div className="card__head">
            <span className="card__label" id="h-health">
              Health
            </span>
            <button className="icon-btn" aria-label="Refresh health" onClick={() => void refresh()}>
              <RefreshCw aria-hidden="true" />
            </button>
          </div>
          <div className="card__body">
            <div className="health-grid">
              {health.map((h) => (
                <div className={`health-cell${h.state === "fault" ? " is-fault" : ""}`} key={h.word}>
                  <span className="health-cell__top">
                    <HealthDot state={h.state} label={h.label} />
                    {h.word}
                  </span>
                  <span className="health-cell__val">{h.value}</span>
                  {h.fault ? <span className="health-cell__remedy">{h.fault}</span> : null}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Recent requests */}
        <section className="card col-12" aria-labelledby="h-recent">
          <div className="card__head">
            <span className="card__label" id="h-recent">
              Recent requests
            </span>
            <a
              href="#/logs"
              className="row gap-1"
              style={{ fontSize: 12, fontWeight: 500 }}
              onClick={(e) => {
                e.preventDefault();
                navigate({ kind: "logs" });
              }}
            >
              View all <ArrowRight style={{ width: 13, height: 13 }} aria-hidden="true" />
            </a>
          </div>
          <div className="card__body--flush mini-list">
            {recentPairs.length ? (
              recentPairs.map((pair) => (
                <div
                  className="mini-row"
                  key={pairKey(pair)}
                  role="link"
                  tabIndex={0}
                  style={{ cursor: "pointer" }}
                  onClick={() => navigate({ kind: "logs", logId: pairOpenId(pair) })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") navigate({ kind: "logs", logId: pairOpenId(pair) });
                  }}
                >
                  <span className="time">{formatTime(pairStartedAt(pair))}</span>
                  <span className="model">{pairModel(pair) ?? "—"}</span>
                  <LogChannelPair channels={asLogChannels(pairChannels(pair))} />
                  <StatusPill status={pairStatus(pair)} />
                  <span className="lat">{formatLatency(pairLatency(pair))}</span>
                </div>
              ))
            ) : (
              <div className="empty" style={{ padding: "24px 20px" }}>
                <p>No requests yet — send a message in Grok Bot.</p>
              </div>
            )}
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={confirmOfficial}
        onClose={() => setConfirmOfficial(false)}
        onConfirm={switchToOfficial}
        title="Switch to Official Grok?"
        description="Chat returns to the stock xAI model. Your catalog and keys are kept."
        consequences={[
          "Chat returns to stock Grok on the next message.",
          "The Grok Bot host process restarts.",
          "Providers, models, and keys are kept for re-enabling.",
          "A running tunnel stays up.",
        ]}
        confirmLabel="Switch to Official"
        busy={busy === "official"}
      />

      <ConfirmDialog
        open={confirmTunnel !== null}
        onClose={() => setConfirmTunnel(null)}
        onConfirm={tunnelAction}
        title={confirmTunnel === "start" ? "Start the tunnel?" : "Stop the tunnel?"}
        description={
          confirmTunnel === "start"
            ? "Anyone with the public URL can open this console. Keys stay on the Computer."
            : "The public URL stops working immediately. Anyone using it loses access."
        }
        confirmLabel={confirmTunnel === "start" ? "Start tunnel" : "Stop tunnel"}
        busy={busy === "tunnel"}
      />
    </>
  );
}
