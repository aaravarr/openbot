import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  RefreshCw,
  ScrollText,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  clearLogs,
  getLog,
  listLogs,
  saveLogSettings,
} from "../api/client";
import type { LogDetail, LogRecord, LogSettings } from "../api/types";
import { formatLatency, formatTime, formatTimestamp } from "../lib/format";
import { navigate } from "../lib/router";
import { useApp, useBoxState } from "../store";
import { Listbox, type ListboxGroup } from "../components/Listbox";
import { ConfirmDialog, Modal } from "../components/overlays";
import { Badge, Button, EmptyState, IconButton, StatusPill } from "../components/ui";
import { NumberInput } from "../components/fields";

type DrawerState = { id: string; detail: LogDetail | null; notFound: boolean };

export function Logs({ logId }: { logId?: string }) {
  const state = useBoxState();
  const { pushToast } = useApp();

  const [settings, setSettings] = useState<LogSettings | null>(state.logSettings ?? null);
  const [recording, setRecording] = useState(settings?.loggingEnabled ?? false);
  const [bodiesAll, setBodiesAll] = useState(settings?.logBodies ?? false);
  const [retention, setRetention] = useState<number | null>(settings?.logRetentionDays ?? 7);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);

  const [records, setRecords] = useState<LogRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [modelFilter, setModelFilter] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);

  useEffect(() => {
    if (state.logSettings) {
      setSettings(state.logSettings);
      setRecording(state.logSettings.loggingEnabled);
      setBodiesAll(state.logSettings.logBodies);
      setRetention(state.logSettings.logRetentionDays);
    }
  }, [state.logSettings]);

  const modelOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const m of state.models) seen.add(m.slug);
    for (const r of records) if (r.model) seen.add(r.model);
    return [...seen];
  }, [state.models, records]);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listLogs({
        q: q || undefined,
        ok: errorsOnly ? false : undefined,
        model: modelFilter ?? undefined,
        pageSize: 100,
      });
      setRecords(list.items);
      setTotal(list.total);
    } catch {
      /* toast */
    } finally {
      setLoading(false);
    }
  }, [q, errorsOnly, modelFilter]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  const openDrawer = useCallback(
    async (id: string) => {
      setDrawer({ id, detail: null, notFound: false });
      setDrawerLoading(true);
      try {
        const detail = await getLog(id);
        setDrawer({ id, detail, notFound: false });
      } catch {
        setDrawer({ id, detail: null, notFound: true });
      } finally {
        setDrawerLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (logId) void openDrawer(logId);
  }, [logId, openDrawer]);

  const saveSettingsAction = async () => {
    setSettingsError(null);
    if (retention === null || retention < 1 || retention > 365 || !Number.isInteger(retention)) {
      setSettingsError("Retention must be a whole number of days between 1 and 365.");
      return;
    }
    setSavingSettings(true);
    try {
      const saved = await saveLogSettings({
        loggingEnabled: recording,
        logBodies: bodiesAll,
        logBodiesOnError: !bodiesAll,
        logRetentionDays: retention,
      });
      setSettings(saved);
      pushToast("success", "Settings saved", `Recording is ${recording ? "on" : "off"} — bodies kept ${bodiesAll ? "for all requests" : "on errors only"}, ${retention}-day retention.`);
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : "Could not save settings.");
    } finally {
      setSavingSettings(false);
    }
  };

  const doClear = async () => {
    setConfirmClear(false);
    try {
      await clearLogs();
      setRecords([]);
      setTotal(0);
      pushToast("success", "Logs cleared", "All request records were deleted.");
    } catch (err) {
      pushToast("error", "Clear failed", err instanceof Error ? err.message : "Could not clear logs.");
    }
  };

  const modelGroups: ListboxGroup[] = useMemo(
    () => [
      {
        label: "Models",
        options: [
          { value: "", label: "All models" },
          ...modelOptions.map((m) => ({ value: m, label: m })),
        ],
      },
    ],
    [modelOptions],
  );

  const recordingOff = !recording;

  return (
    <>
      <div className="page-title-row">
        <h1>Logs</h1>
        <span className="sub">What did the hop actually do?</span>
      </div>

      {/* Settings */}
      <section className="card" style={{ marginBottom: 16 }}>
        <button
          className="card__head"
          style={{ width: "100%", background: "transparent", border: "none", cursor: "pointer", font: "inherit" }}
          onClick={() => setSettingsOpen((s) => !s)}
          aria-expanded={settingsOpen}
        >
          <span className="card__label">
            <Settings2 style={{ width: 13, height: 13 }} aria-hidden="true" />
            Recording settings
          </span>
          <ChevronDown
            style={{ width: 14, height: 14, color: "var(--muted)", transform: settingsOpen ? "rotate(180deg)" : "none", transition: "transform 150ms" }}
            aria-hidden="true"
          />
        </button>
        {settingsOpen ? (
          <div className="card__body stack" style={{ gap: 14 }}>
            <div className="row row--between wrap gap-3">
              <label className="switch">
                <input type="checkbox" role="switch" checked={recording} onChange={(e) => setRecording(e.target.checked)} />
                <span className="switch__track"><span className="switch__thumb" /></span>
                <span className="switch__label">Recording</span>
              </label>
              <div className="row gap-3" style={{ fontSize: 13 }}>
                <span style={{ color: "var(--muted)" }}>Bodies:</span>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input type="radio" name="bodies" checked={!bodiesAll} onChange={() => setBodiesAll(false)} style={{ accentColor: "var(--primary)" }} />
                  Errors only
                </label>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                  <input type="radio" name="bodies" checked={bodiesAll} onChange={() => setBodiesAll(true)} style={{ accentColor: "var(--primary)" }} />
                  All
                </label>
              </div>
              <div className="row gap-2">
                <span style={{ color: "var(--muted)", fontSize: 13 }}>Retention</span>
                <NumberInput value={retention} onChange={setRetention} min={1} max={365} className="input--mono" ariaLabel="Retention days" />
                <span style={{ color: "var(--muted)", fontSize: 13 }}>days</span>
              </div>
              <Button variant="primary" loading={savingSettings} onClick={saveSettingsAction}>
                Save settings
              </Button>
            </div>
            {settingsError ? <span className="field" style={{ color: "var(--danger)" }}>{settingsError}</span> : null}
            <div className="notice notice--info">
              <ShieldCheck aria-hidden="true" />
              <span className="text">Keys are always redacted server-side; bodies default off.</span>
            </div>
          </div>
        ) : null}
      </section>

      {/* Toolbar + table */}
      <section className="card" aria-label="Request records">
        <div className="card__head" style={{ flexWrap: "wrap", gap: 10 }}>
          <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
            <Search style={{ position: "absolute", left: 9, width: 13, height: 13, color: "var(--muted)", pointerEvents: "none" }} aria-hidden="true" />
            <input
              className="input"
              style={{ paddingLeft: 28, width: 220, height: 30 }}
              placeholder="Search id, model, error…"
              aria-label="Search records"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </span>
          <label className="switch" style={{ fontSize: 12 }}>
            <input type="checkbox" role="switch" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} />
            <span className="switch__track"><span className="switch__thumb" /></span>
            <span className="switch__label">Errors only</span>
          </label>
          <Listbox
            label="Filter by model"
            groups={modelGroups}
            value={modelFilter ?? ""}
            onChange={(v) => setModelFilter(v || null)}
            triggerStyle={{ height: 30 }}
          />
          <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
            {total} record{total === 1 ? "" : "s"}
          </span>
          <span style={{ flex: 1 }} />
          <IconButton label="Refresh records" icon={RefreshCw} onClick={() => void loadRecords()} />
          <Button variant="ghost-danger" icon={Trash2} onClick={() => setConfirmClear(true)}>
            Clear all
          </Button>
        </div>

        <div className="card__body--flush table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Time</th>
                <th>Model</th>
                <th>Status</th>
                <th className="num">Latency</th>
                <th className="num">Tokens</th>
                <th>Stream</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={7} style={{ padding: 0 }}><div className="skel skel--row" /></td>
                  </tr>
                ))
              ) : records.length ? (
                records.map((r) => (
                  <tr
                    key={r.id}
                    className="is-clickable"
                    tabIndex={0}
                    onClick={() => void openDrawer(r.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void openDrawer(r.id);
                    }}
                  >
                    <td className="mono">{formatTime(r.startedAt)}</td>
                    <td className="mono">{r.model ?? "—"}</td>
                    <td><StatusPill status={r.status} /></td>
                    <td className="num mono">{formatLatency(r.latencyMs)}</td>
                    <td className="num mono">{r.totalTokens ?? "—"}</td>
                    <td className="mono">{r.stream ? "yes" : "no"}</td>
                    <td className="ellipsis" style={r.error ? { color: "var(--danger)" } : undefined}>
                      {r.error ?? "—"}
                    </td>
                  </tr>
                ))
              ) : recordingOff ? (
                <tr>
                  <td colSpan={7}>
                    <EmptyState
                      icon={ScrollText}
                      title="Recording is off"
                      body="Turn on recording to capture future turns. Requests made before recording was enabled are not recoverable."
                      action={
                        <Button variant="primary" onClick={() => setSettingsOpen(true)}>
                          Turn on recording
                        </Button>
                      }
                    />
                  </td>
                </tr>
              ) : (
                <tr>
                  <td colSpan={7}>
                    <EmptyState
                      icon={ScrollText}
                      title="No requests yet"
                      body="Send a message in Grok Bot and it will appear here."
                    />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <ConfirmDialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={doClear}
        title="Clear all logs?"
        description="Every request record and captured body is deleted permanently."
        confirmLabel="Clear all logs"
        icon={Trash2}
        iconTone="danger"
      />

      <LogDrawer
        state={drawer}
        loading={drawerLoading}
        onClose={() => {
          setDrawer(null);
          navigate({ kind: "logs" });
        }}
      />
    </>
  );
}

function LogDrawer({
  state,
  loading,
  onClose,
}: {
  state: DrawerState | null;
  loading: boolean;
  onClose: () => void;
}) {
  const d = state?.detail;
  return (
    <Modal open={state !== null} onClose={onClose} drawer labelledBy="drawer-id">
      {state ? (
        <div className="drawer">
          <div className="drawer__head">
            <div className="drawer__title">
              <span className="id" id="drawer-id">{state.id}</span>
              {d ? (
                <span className="sub">{formatTime(d.startedAt)} · {formatLatency(d.latencyMs)}</span>
              ) : null}
            </div>
            {d ? <StatusPill status={d.status} /> : null}
            <IconButton label="Close" icon={X} onClick={onClose} />
          </div>
          <div className="drawer__body">
            {loading ? (
              <>
                <div className="skel skel--line" style={{ width: "70%" }} />
                <div className="skel skel--line" style={{ width: "90%" }} />
                <div className="skel skel--block" />
              </>
            ) : state.notFound ? (
              <div className="notice notice--warn">
                <span className="text">This record was pruned by retention.</span>
              </div>
            ) : d ? (
              <>
                <div className="drawer-section">
                  <span className="section-label">Overview</span>
                  <div className="def-grid">
                    <span className="k">Provider</span>
                    <span className="v">{d.providerName ?? "—"}</span>
                    <span className="k">Model</span>
                    <span className="v mono">{d.model ?? "—"}</span>
                    <span className="k">Started</span>
                    <span className="v mono">{formatTimestamp(d.startedAt)}</span>
                    <span className="k">Completed</span>
                    <span className="v mono">{formatTimestamp(d.completedAt)}</span>
                    <span className="k">Streaming</span>
                    <span className="v mono">{d.stream ? "true" : "false"}</span>
                    <span className="k">Inbound</span>
                    <span className="v mono">{d.inboundEndpoint ?? "POST /v1/chat/completions"}</span>
                  </div>
                </div>

                {d.error ? (
                  <div className="drawer-section">
                    <span className="section-label">Error</span>
                    <div className="error-block">
                      <span>{d.error}</span>
                      <span className="mono">status {d.status}</span>
                    </div>
                  </div>
                ) : null}

                <div className="drawer-section">
                  <span className="section-label">Token usage</span>
                  <div className="token-trio">
                    <div className="token-stat"><div className="k">Prompt</div><div className="v">{d.promptTokens ?? "—"}</div></div>
                    <div className="token-stat"><div className="k">Completion</div><div className="v">{d.completionTokens ?? "—"}</div></div>
                    <div className="token-stat"><div className="k">Total</div><div className="v">{d.totalTokens ?? "—"}</div></div>
                  </div>
                </div>

                {d.upstreamEndpoint ? (
                  <div className="drawer-section">
                    <span className="section-label">Upstream endpoint</span>
                    <div className="code-pane">{d.upstreamEndpoint}</div>
                  </div>
                ) : null}

                {d.hasRequest ? (
                  <div className="drawer-section">
                    <span className="section-label">Request body <span style={{ color: "var(--muted)", textTransform: "none", letterSpacing: 0 }}>· keys redacted</span></span>
                    <div className="code-pane">{stringifyBody(d.request)}</div>
                    {d.requestTruncated ? <span style={{ fontSize: 12, color: "var(--muted)" }}>Body truncated by retention settings.</span> : null}
                  </div>
                ) : null}

                {d.hasResponse ? (
                  <div className="drawer-section">
                    <span className="section-label">Response body <span style={{ color: "var(--muted)", textTransform: "none", letterSpacing: 0 }}>· redacted</span></span>
                    <div className="code-pane">{stringifyBody(d.response)}</div>
                    {d.responseTruncated ? <span style={{ fontSize: 12, color: "var(--muted)" }}>Body truncated by retention settings.</span> : null}
                  </div>
                ) : null}

                {!d.hasRequest && !d.hasResponse ? (
                  <div className="notice notice--info">
                    <span className="text">Bodies were not kept — recording keeps bodies on errors only by default.</span>
                  </div>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function stringifyBody(body: unknown): string {
  if (body === null || body === undefined) return "—";
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body, null, 2);
  } catch {
    return String(body);
  }
}
