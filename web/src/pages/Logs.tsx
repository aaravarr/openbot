import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
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
  cleanupLogs,
  fetchLogUsage,
  getLog,
  getLogFacets,
  getLogStats,
  listLogs,
  listEvents,
  saveLogSettings,
  stripLogBodies,
} from "../api/client";
import type {
  LogChannel,
  LogChannelFilter,
  LogDetail,
  LogEvent,
  LogFacets,
  LogRecord,
  LogSettings,
  LogStats,
  LogUsage,
  LogUsageRow,
} from "../api/types";
import { LogChannelPair } from "../components/LogChannel";
import { channelSubtitle, formatLatency, formatTime, formatTimestamp } from "../lib/format";
import {
  findPairById,
  pairChannels,
  pairContainsId,
  pairError,
  pairIds,
  pairKey,
  pairLatency,
  pairLogRows,
  pairModel,
  pairStartedAt,
  pairStatus,
  pairStream,
  pairTokens,
  type LogRowPair,
} from "../lib/pair-logs";
import { navigate } from "../lib/router";
import { useApp, useBoxState } from "../store";
import { Listbox, type ListboxGroup } from "../components/Listbox";
import { ConfirmDialog, Modal } from "../components/overlays";
import { Button, EmptyState, IconButton, StatusPill } from "../components/ui";
import { NumberInput } from "../components/fields";

type DrawerState = { ids: string[]; details: LogDetail[]; notFound: boolean };

const PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;

function asLogChannels(values: ReadonlyArray<string | undefined>): Array<LogChannel | undefined> {
  return values.map((value) => {
    if (value === "official" || value === "custom-host" || value === "hop") return value;
    return undefined;
  });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function Logs({ logId, page: routePage }: { logId?: string; page?: number }) {
  const state = useBoxState();
  const { pushToast } = useApp();

  const [page, setPage] = useState(() => (routePage !== undefined && routePage >= 1 ? routePage : 1));
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

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
  const [channelFilter, setChannelFilter] = useState<LogChannelFilter | "">("");
  const [modelFilter, setModelFilter] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);

  const [activeTab, setActiveTab] = useState<"requests" | "events" | "usage">("requests");
  const [usage, setUsage] = useState<LogUsage | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [stats, setStats] = useState<LogStats | null>(null);
  const [facets, setFacets] = useState<LogFacets | null>(null);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [eventsTotal, setEventsTotal] = useState(0);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [severityFilter, setSeverityFilter] = useState("");
  const [confirmStrip, setConfirmStrip] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);

  useEffect(() => {
    if (state.logSettings) {
      setSettings(state.logSettings);
      setRecording(state.logSettings.loggingEnabled);
      setBodiesAll(state.logSettings.logBodies);
      setRetention(state.logSettings.logRetentionDays);
    }
  }, [state.logSettings]);

  const modelOptions = useMemo(() => {
    if (facets && facets.model.values.length > 0) {
      return facets.model.values.map((option) => option.value);
    }
    const seen = new Set<string>();
    for (const m of state.models) seen.add(m.slug);
    for (const r of records) if (r.model) seen.add(r.model);
    return [...seen];
  }, [facets, state.models, records]);

  const pairs = useMemo(() => pairLogRows(records), [records]);
  // The source column only appears once the backend stamps source fields; older
  // rows render without it instead of a column of dashes.
  const hasSourceColumn = useMemo(() => records.some(hasSource), [records]);

  const routePageValue = routePage !== undefined && routePage >= 1 ? routePage : 1;

  // Keep the internal page in step with the URL when it changes from outside
  // (browser back/forward, pasted deep link). Pager actions set state first, so
  // the route echo that follows is a no-op.
  useEffect(() => {
    setPage(routePageValue);
  }, [routePageValue]);

  const goToPage = useCallback((next: number) => {
    setPage(next);
    navigate({ kind: "logs", page: next > 1 ? next : undefined });
  }, []);

  const loadRecords = useCallback(async () => {
    setLoading(true);
    try {
      const list = await listLogs({
        q: q || undefined,
        ok: errorsOnly ? false : undefined,
        channel: channelFilter || undefined,
        model: modelFilter ?? undefined,
        page,
        pageSize,
      });
      const lastPage = Math.max(1, Math.ceil(list.total / pageSize));
      if (page > lastPage) {
        // The requested page slipped past the last valid page (e.g. records were
        // pruned by retention, or all were cleared). Land on a valid page instead
        // of an empty state.
        setTotal(list.total);
        setRecords([]);
        goToPage(lastPage);
        return; // keep loading until the corrected page resolves
      }
      setRecords(list.items);
      setTotal(list.total);
      setLoading(false);
    } catch {
      setLoading(false);
    }
  }, [q, errorsOnly, channelFilter, modelFilter, page, pageSize, goToPage]);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  // Stats + facets are lazy and non-blocking: a failure hides the extras but
  // never blocks the record list.
  const refreshStats = useCallback(async () => {
    try {
      setStats(await getLogStats());
    } catch {
      /* stats stay hidden; the list is the source of truth */
    }
  }, []);

  useEffect(() => {
    void refreshStats();
    listEvents({ limit: 1 })
      .then((list) => setEventsTotal(list.total))
      .catch(() => {
        /* events tab will retry on open */
      });
    getLogFacets()
      .then((f) => setFacets(f))
      .catch(() => {
        /* filters fall back to local options */
      });
  }, [refreshStats]);

  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    try {
      const list = await listEvents({ severity: severityFilter || undefined, limit: 100 });
      setEvents(list.items);
      setEventsTotal(list.total);
    } catch {
      /* keep previous events */
    } finally {
      setEventsLoading(false);
    }
  }, [severityFilter]);

  useEffect(() => {
    if (activeTab === "events") void loadEvents();
  }, [activeTab, loadEvents]);
 
  // Usage is a lazy extra: it loads only when the tab opens, and a failure
  // shows a note without ever blocking the request list.
  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    setUsageError(null);
    try {
      setUsage(await fetchLogUsage());
    } catch (err) {
      setUsageError(err instanceof Error ? err.message : "Could not load usage.");
    } finally {
      setUsageLoading(false);
    }
  }, []);
 
  useEffect(() => {
    if (activeTab === "usage" && usage === null && !usageLoading && !usageError) void loadUsage();
  }, [activeTab, usage, usageLoading, usageError, loadUsage]);

  const doCleanup = async () => {
    setCleanupBusy(true);
    try {
      const result = await cleanupLogs();
      pushToast(
        "success",
        "Cleanup done",
        `${String(result.removedByRetention ?? 0)} expired, ${String(result.removedByCap ?? 0)} over cap removed, ${String(result.kept ?? 0)} kept.`,
      );
      await refreshStats();
      await loadRecords();
      if (activeTab === "events") await loadEvents();
    } catch (err) {
      pushToast("error", "Cleanup failed", err instanceof Error ? err.message : "Could not clean logs.");
    } finally {
      setCleanupBusy(false);
    }
  };

  const doStrip = async () => {
    setConfirmStrip(false);
    try {
      const result = await stripLogBodies();
      pushToast("success", "Bodies stripped", `${String(result.stripped)} captured bodies deleted; metadata kept.`);
      await refreshStats();
      await loadRecords();
    } catch (err) {
      pushToast("error", "Strip failed", err instanceof Error ? err.message : "Could not strip bodies.");
    }
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const resetToFirstPage = useCallback(() => {
    if (page !== 1) goToPage(1);
  }, [page, goToPage]);

  const onPageSizeChange = useCallback(
    (value: string) => {
      const next = Number(value);
      if (!(PAGE_SIZES as readonly number[]).includes(next)) return;
      setPageSize(next);
      goToPage(1);
    },
    [goToPage],
  );

  const openDrawer = useCallback(
    async (ids: readonly string[]) => {
      const unique = [...new Set(ids.filter(Boolean))];
      setDrawer({ ids: unique, details: [], notFound: false });
      setDrawerLoading(true);
      try {
        const details: LogDetail[] = [];
        for (const id of unique) {
          try {
            details.push(await getLog(id));
          } catch {
            /* pruned */
          }
        }
        setDrawer({ ids: unique, details, notFound: details.length === 0 });
      } finally {
        setDrawerLoading(false);
      }
    },
    [],
  );

  const openPair = useCallback(
    (pair: LogRowPair<LogRecord>) => {
      void openDrawer(pairIds(pair));
    },
    [openDrawer],
  );

  useEffect(() => {
    if (!logId) return;
    const match = findPairById(pairs, logId);
    if (match) {
      void openDrawer(pairIds(match));
      return;
    }
    void openDrawer([logId]);
  }, [logId, pairs, openDrawer]);

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
      if (saved.wrapError) {
        setSettingsError(`Recording saved, but the host tap could not be applied (${saved.wrapError}).`);
        pushToast("error", "Settings saved", `Recording is ${recording ? "on" : "off"} — the host tap could not be applied (${saved.wrapError}).`);
      } else if (saved.wrapBytesChanged) {
        pushToast("info", "Settings saved", recording
          ? "Official Grok capture is on. The host restarted; send a new message to record a turn."
          : "Official tap removed. Chat is stock Grok again.");
      } else {
        pushToast("success", "Settings saved", `Recording is ${recording ? "on" : "off"} — bodies kept ${bodiesAll ? "for all requests" : "on errors only"}, ${retention}-day retention.`);
      }
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
      goToPage(1);
      pushToast("success", "Logs cleared", "All request records were deleted.");
      await refreshStats();
      if (activeTab === "events") await loadEvents();
      if (activeTab === "usage") await loadUsage();
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

  const channelGroups: ListboxGroup[] = useMemo(
    () => [
      {
        label: "Channel",
        options: [
          { value: "", label: "All channels" },
          { value: "official", label: "Official", sublabel: "Stock Grok tap" },
          { value: "custom", label: "Custom", sublabel: "Upstream + harness" },
        ],
      },
    ],
    [],
  );

  const severityGroups: ListboxGroup[] = useMemo(
    () => [
      {
        label: "Severity",
        options: [
          { value: "", label: "All severities" },
          { value: "INFO", label: "Info" },
          { value: "WARN", label: "Warnings" },
          { value: "ERROR", label: "Errors" },
        ],
      },
    ],
    [],
  );

  const pageSizeGroups: ListboxGroup[] = useMemo(
    () => [
      {
        label: "Per page",
        options: PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} records` })),
      },
    ],
    [],
  );

  const recordingOff = !recording;
  const turnCount = pairs.length;
  const openId = drawer?.ids[0];

  return (
    <>
      <div className="page-title-row">
        <h1>Logs</h1>
        <span className="sub">One custom turn is an upstream call plus a harness stream — not two events.</span>
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

      {/* Storage overview: lazy-loaded, never blocks the record list */}
      {stats ? (
        <section className="card logs-stats" aria-label="Log storage">
          <div className="logs-stats__row">
            <span className="logs-stats__item">
              <span className="k">Records</span>
              <span className="v mono">
                {stats.records}
                {stats.approximate ? " ~" : ""}
              </span>
            </span>
            <span className="logs-stats__item">
              <span className="k">Errors</span>
              <span className="v mono">{stats.errors}</span>
            </span>
            <span className="logs-stats__item">
              <span className="k">Tokens</span>
              <span className="v mono">{stats.totalTokens}</span>
            </span>
            <span className="logs-stats__item">
              <span className="k">Disk</span>
              <span className="v mono">
                {formatBytes(stats.diskBytes)}
                {stats.bodiesApproximate ? " ~" : ""}
              </span>
            </span>
            <span className="logs-stats__spacer" />
            <Button variant="ghost-sm" onClick={() => void doCleanup()} disabled={cleanupBusy}>
              {cleanupBusy ? "Cleaning…" : "Run cleanup"}
            </Button>
            <Button variant="ghost-danger" icon={Trash2} onClick={() => setConfirmStrip(true)}>
              Strip bodies
            </Button>
          </div>
          {stats.approximate ? (
            <span className="logs-stats__note">Counts sampled from recent records.</span>
          ) : null}
        </section>
      ) : null}

      <div className="logs-tabs" role="tablist" aria-label="Log views">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "requests"}
          className={`logs-tab${activeTab === "requests" ? " is-active" : ""}`}
          onClick={() => setActiveTab("requests")}
        >
          Requests
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "events"}
          className={`logs-tab${activeTab === "events" ? " is-active" : ""}`}
          onClick={() => setActiveTab("events")}
        >
          Events{eventsTotal > 0 ? ` (${eventsTotal})` : ""}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "usage"}
          className={`logs-tab${activeTab === "usage" ? " is-active" : ""}`}
          onClick={() => setActiveTab("usage")}
        >
          Usage
        </button>
      </div>

      {activeTab === "events" ? (
        <section className="card" aria-label="Log events">
          <div className="card__head logs-toolbar">
            <Listbox
              label="Filter by severity"
              groups={severityGroups}
              value={severityFilter}
              onChange={(v) => setSeverityFilter(v)}
              triggerStyle={{ height: 30 }}
            />
            <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
              {eventsTotal} event{eventsTotal === 1 ? "" : "s"}
            </span>
            <span className="logs-toolbar__spacer" />
            <IconButton label="Refresh events" icon={RefreshCw} onClick={() => void loadEvents()} />
          </div>
          <div className="card__body--flush table-wrap">
            <table className="data table--stack">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Severity</th>
                  <th>Type</th>
                  <th>Message</th>
                </tr>
              </thead>
              <tbody>
                {eventsLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <tr className="row-empty" key={i}>
                      <td colSpan={4} style={{ padding: 0 }}>
                        <div className="skel skel--row" />
                      </td>
                    </tr>
                  ))
                ) : events.length ? (
                  events.map((event) => (
                    <tr key={event.id}>
                      <td className="mono" data-label="Time">
                        {formatTime(event.at)}
                      </td>
                      <td data-label="Severity">
                        <span className={`log-sev log-sev--${event.severity}`}>{event.severity}</span>
                      </td>
                      <td className="mono" data-label="Type">
                        {event.type}
                      </td>
                      <td className="ellipsis" data-label="Message">
                        {event.message}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr className="row-empty">
                    <td colSpan={4}>
                      <EmptyState
                        icon={ScrollText}
                        title="No events yet"
                        body="Settings changes and cleanups will appear here."
                      />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : activeTab === "usage" ? (
        <UsageSection usage={usage} loading={usageLoading} error={usageError} onRetry={() => void loadUsage()} />
      ) : (
      <>
      {/* Toolbar + table */}
      <section className="card" aria-label="Request records">
        <div className="card__head logs-toolbar">
          <span className="logs-search">
            <Search style={{ position: "absolute", left: 9, width: 13, height: 13, color: "var(--muted)", pointerEvents: "none" }} aria-hidden="true" />
            <input
              className="input"
              placeholder="Search id, model, error…"
              aria-label="Search records"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                resetToFirstPage();
              }}
            />
          </span>
          <label className="switch" style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              role="switch"
              checked={errorsOnly}
              onChange={(e) => {
                setErrorsOnly(e.target.checked);
                resetToFirstPage();
              }}
            />
            <span className="switch__track"><span className="switch__thumb" /></span>
            <span className="switch__label">Errors only</span>
          </label>
          <Listbox
            label="Filter by channel"
            groups={channelGroups}
            value={channelFilter}
            onChange={(v) => {
              setChannelFilter(v === "official" || v === "custom" ? v : "");
              resetToFirstPage();
            }}
            triggerStyle={{ height: 30 }}
          />
          <Listbox
            label="Filter by model"
            groups={modelGroups}
            value={modelFilter ?? ""}
            onChange={(v) => {
              setModelFilter(v || null);
              resetToFirstPage();
            }}
            triggerStyle={{ height: 30 }}
          />
          <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
            {turnCount} turn{turnCount === 1 ? "" : "s"}
            {total !== turnCount ? ` · ${String(total)} records` : ""}
          </span>
          <span className="logs-toolbar__spacer" />
          <IconButton label="Refresh records" icon={RefreshCw} onClick={() => void loadRecords()} />
          <Button variant="ghost-danger" icon={Trash2} onClick={() => setConfirmClear(true)}>
            Clear all
          </Button>
        </div>

        <div className="card__body--flush table-wrap">
          <table className="data table--stack">
            <thead>
              <tr>
                <th>Time</th>
                <th>Channel</th>
                <th>Model</th>
                {hasSourceColumn ? <th>Source</th> : null}
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
                  <tr className="row-empty" key={i}>
                    <td colSpan={hasSourceColumn ? 9 : 8} style={{ padding: 0 }}><div className="skel skel--row" /></td>
                  </tr>
                ))
              ) : pairs.length ? (
                pairs.map((pair) => {
                  const error = pairError(pair);
                  const selected = openId ? pairContainsId(pair, openId) : false;
                  return (
                    <tr
                      key={pairKey(pair)}
                      className={`is-clickable${selected ? " is-open" : ""}`}
                      tabIndex={0}
                      onClick={() => openPair(pair)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") openPair(pair);
                      }}
                    >
                      <td className="mono" data-label="Time">{formatTime(pairStartedAt(pair))}</td>
                      <td data-label="Channel">
                        <LogChannelPair channels={asLogChannels(pairChannels(pair))} />
                      </td>
                      <td className="mono" data-label="Model">{pairModel(pair) ?? "—"}</td>
                      {hasSourceColumn ? (
                        <td className="ellipsis" data-label="Source">
                          {pairSourceLabel(pair) ?? "—"}
                        </td>
                      ) : null}
                      <td data-label="Status"><StatusPill status={pairStatus(pair)} /></td>
                      <td className="num mono" data-label="Latency">{formatLatency(pairLatency(pair))}</td>
                      <td className="num mono" data-label="Tokens">{pairTokens(pair) ?? "—"}</td>
                      <td className="mono" data-label="Stream">{pairStream(pair) ? "yes" : "no"}</td>
                      <td className="ellipsis" data-label="Error" style={error ? { color: "var(--danger)" } : undefined}>
                        {error ?? "—"}
                      </td>
                    </tr>
                  );
                })
              ) : recordingOff ? (
                <tr className="row-empty">
                  <td colSpan={hasSourceColumn ? 9 : 8}>
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
                <tr className="row-empty">
                  <td colSpan={hasSourceColumn ? 9 : 8}>
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

        <footer className="logs-pager">
          <span className="logs-pager__count" aria-live="polite">
            {total} record{total === 1 ? "" : "s"}
          </span>
          <div className="logs-pager__nav">
            <Button
              variant="ghost-sm"
              icon={ChevronLeft}
              aria-label="Previous page"
              disabled={page <= 1}
              onClick={() => goToPage(page - 1)}
            />
            <span className="logs-pager__status">Page {page} of {totalPages}</span>
            <Button
              variant="ghost-sm"
              icon={ChevronRight}
              aria-label="Next page"
              disabled={page >= totalPages}
              onClick={() => goToPage(page + 1)}
            />
          </div>
          <div className="logs-pager__size">
            <Listbox
              label="Records per page"
              groups={pageSizeGroups}
              value={String(pageSize)}
              onChange={onPageSizeChange}
              triggerStyle={{ height: 28 }}
            />
          </div>
        </footer>
      </section>
      </>
      )}

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

      <ConfirmDialog
        open={confirmStrip}
        onClose={() => setConfirmStrip(false)}
        onConfirm={() => void doStrip()}
        title="Strip all bodies?"
        description="Captured request and response payloads are deleted permanently; record metadata stays browsable."
        confirmLabel="Strip bodies"
        icon={Trash2}
        iconTone="danger"
      />

      <LogDrawer
        state={drawer}
        loading={drawerLoading}
        onClose={() => {
          setDrawer(null);
          navigate({ kind: "logs", page: page > 1 ? page : undefined });
        }}
      />
    </>
  );
}

/** Members behind a rendered row: a single record, or the hop + harness pair. */
function pairMembers(pair: LogRowPair<LogRecord>): LogRecord[] {
  return pair.kind === "pair" ? [pair.hop, pair.harness] : [pair.record];
}
 
function hasSource(r: LogRecord): boolean {
  return Boolean(r.botName || r.chatType || r.chatName || r.clientName || r.clientVersion || r.conversationId || r.userAgent);
}
 
/** Short source label for list rows; prefers client name, then conversation, then UA. */
function sourceLabel(r: LogRecord): string | undefined {
  const bot = r.botName?.trim();
  const chat = r.chatType === "group"
    ? "Group: " + (r.chatName?.trim() || "—")
    : r.chatType === "dm"
      ? "Direct message"
      : r.chatType === "routine"
        ? "Routine"
        : undefined;
  if (bot && chat) return bot + " · " + chat;
  if (bot) return bot;
  if (chat) return chat;
  const name = r.clientName?.trim();
  if (name) {
    const version = r.clientVersion?.trim();
    return version ? `${name} ${version}` : name;
  }
  const conversation = r.conversationId?.trim();
  if (conversation) {
    return conversation.length > 18 ? `…${conversation.slice(-16)}` : conversation;
  }
  const ua = r.userAgent?.trim();
  if (ua) return ua.length > 32 ? `${ua.slice(0, 31)}…` : ua;
  return undefined;
}
 
function pairSourceLabel(pair: LogRowPair<LogRecord>): string | undefined {
  for (const member of pairMembers(pair)) {
    const label = sourceLabel(member);
    if (label) return label;
  }
  return undefined;
}
 
/** True when a body was kept in metadata but its text is (temporarily) unreadable. */
function isBodyMissing(has: boolean, body: unknown): boolean {
  if (!has) return false;
  if (body === null || body === undefined) return true;
  if (typeof body === "string" && body.length === 0) return true;
  return false;
}
 
/** Complete clipboard text: the full body when the record carries it, else the preview. */
function fullRequestText(d: LogDetail): string | null {
  return rawBodyText(d.request ?? d.requestBody, d.requestFull);
}
 
function fullResponseText(d: LogDetail): string | null {
  return rawBodyText(d.response ?? d.responseBody, d.responseFull);
}
 
type UsageGroup = {
  key: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  requestCount: number;
  ok: number;
  fail: number;
  avgLatencyMs?: number;
  avgFirstTokenMs?: number;
}

/** Aggregate usage rows by an arbitrary key; latencies are request-weighted. */
function groupUsage(rows: LogUsageRow[], pick: (row: LogUsageRow) => string): UsageGroup[] {
  const acc = new Map<string, UsageGroup & { latSum: number; latN: number; firstSum: number; firstN: number }>();
  for (const row of rows) {
    const key = pick(row).trim() || "未知";
    let g = acc.get(key);
    if (!g) {
      g = { key, promptTokens: 0, completionTokens: 0, totalTokens: 0, requestCount: 0, ok: 0, fail: 0, latSum: 0, latN: 0, firstSum: 0, firstN: 0 };
      acc.set(key, g);
    }
    g.promptTokens += row.promptTokens;
    g.completionTokens += row.completionTokens;
    g.totalTokens += row.totalTokens;
    g.requestCount += row.requests;
    g.ok += row.ok;
    g.fail += row.fail;
    if (row.avgLatencyMs !== undefined) {
      const weight = Math.max(1, row.requests);
      g.latSum += row.avgLatencyMs * weight;
      g.latN += weight;
    }
    if (row.avgFirstTokenMs !== undefined) {
      const weight = Math.max(1, row.requests);
      g.firstSum += row.avgFirstTokenMs * weight;
      g.firstN += weight;
    }
  }
  const groups = [...acc.values()].map(({ latSum, latN, firstSum, firstN, ...rest }) => ({
    ...rest,
    avgLatencyMs: latN > 0 ? latSum / latN : undefined,
    avgFirstTokenMs: firstN > 0 ? firstSum / firstN : undefined,
  }));
  groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return groups;
}

/** Backend `byDay` / `byModel` rows arrive pre-aggregated; no grouping needed. */
function toUsageGroup(row: LogUsageRow): UsageGroup {
  return {
    key: row.key,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    totalTokens: row.totalTokens,
    requestCount: row.requests,
    ok: row.ok,
    fail: row.fail,
    avgLatencyMs: row.avgLatencyMs,
    avgFirstTokenMs: row.avgFirstTokenMs,
  };
}
 
/** Approximate counts render with the “约” marker. */
function usageCount(value: number, approximate: boolean): string {
  return `${approximate ? "约 " : ""}${value.toLocaleString("en-US")}`;
}
 
/** Dependency-free bar: a thin proportional fill under the total cell. */
function UsageBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div
      aria-hidden="true"
      style={{ height: 6, borderRadius: 3, background: "var(--surface-3)", overflow: "hidden", marginTop: 4, minWidth: 80 }}
    >
      <div style={{ height: "100%", width: `${pct}%`, background: "var(--primary)", borderRadius: 3 }} />
    </div>
  );
}
 
function UsageTable({
  caption,
  keyLabel,
  groups,
  approximate,
  showOkFail,
}: {
  caption: string;
  keyLabel: string;
  groups: UsageGroup[];
  approximate: boolean;
  showOkFail?: boolean;
}) {
  const maxTotal = groups.reduce((max, g) => Math.max(max, g.totalTokens), 0);
  const showFirstToken = groups.some((g) => g.avgFirstTokenMs !== undefined);
  return (
    <div>
      <span className="section-label">{caption}</span>
      <div className="card__body--flush table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>{keyLabel}</th>
              <th className="num">请求数</th>
              {showOkFail ? <th className="num">成功</th> : null}
              {showOkFail ? <th className="num">失败</th> : null}
              <th className="num">输入</th>
              <th className="num">输出</th>
              <th className="num">总计</th>
              <th className="num">平均延迟</th>
              {showFirstToken ? <th className="num">首 token</th> : null}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <tr key={g.key}>
                <td className="mono">{g.key}</td>
                <td className="num mono">{usageCount(g.requestCount, approximate)}</td>
                {showOkFail ? <td className="num mono">{usageCount(g.ok, approximate)}</td> : null}
                {showOkFail ? <td className="num mono">{usageCount(g.fail, approximate)}</td> : null}
                <td className="num mono">{usageCount(g.promptTokens, approximate)}</td>
                <td className="num mono">{usageCount(g.completionTokens, approximate)}</td>
                <td className="num mono">
                  {usageCount(g.totalTokens, approximate)}
                  <UsageBar value={g.totalTokens} max={maxTotal} />
                </td>
                <td className="num mono">{formatLatency(g.avgLatencyMs)}</td>
                {showFirstToken ? <td className="num mono">{formatLatency(g.avgFirstTokenMs)}</td> : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
 
function UsageSection({
  usage,
  loading,
  error,
  onRetry,
}: {
  usage: LogUsage | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const dayRows = usage?.byDay ?? [];
  const modelRows = usage?.byModel ?? [];
  const approximate = usage?.approximate === true;

  // byDay / byModel are two groupings of the same requests: totals count each
  // request once (day grouping wins), and fall back to legacy rows if needed.
  const totalSource = dayRows.length > 0 ? dayRows : modelRows.length > 0 ? modelRows : (usage?.rows ?? []);
  const totals = useMemo(() => {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let requestCount = 0;
    let latSum = 0;
    let latN = 0;
    for (const row of totalSource) {
      promptTokens += row.promptTokens;
      completionTokens += row.completionTokens;
      totalTokens += row.totalTokens;
      requestCount += row.requests;
      if (row.avgLatencyMs !== undefined) {
        const weight = Math.max(1, row.requests);
        latSum += row.avgLatencyMs * weight;
        latN += weight;
      }
    }
    return {
      promptTokens,
      completionTokens,
      totalTokens,
      requestCount,
      avgLatencyMs: latN > 0 ? latSum / latN : undefined,
    };
  }, [totalSource]);

  // The backend pre-aggregates both groupings; only regroup legacy fallbacks.
  const legacyRows = usage?.rows ?? [];
  const legacyByDay = useMemo(
    () => (dayRows.length === 0 && legacyRows.length > 0 ? groupUsage(legacyRows, (row) => row.key || "未知") : []),
    [dayRows.length, legacyRows],
  );
  const byDay = useMemo(() => dayRows.map(toUsageGroup), [dayRows]);
  const byModel = useMemo(() => modelRows.map(toUsageGroup), [modelRows]);
  const dayGroups = byDay.length > 0 ? byDay : legacyByDay;
  const isEmpty = dayGroups.length === 0 && byModel.length === 0;

  return (
    <section className="card" aria-label="Token usage">
      <div className="card__head logs-toolbar">
        <span className="card__label">Usage{approximate ? " 约" : ""}</span>
        <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
          按天 / 按模型聚合{approximate ? "（约）" : ""}
        </span>
        <span className="logs-toolbar__spacer" />
        <IconButton label="Refresh usage" icon={RefreshCw} onClick={onRetry} />
      </div>
      {loading && isEmpty ? (
        <div className="card__body stack" style={{ gap: 8 }}>
          <div className="skel skel--line" style={{ width: "60%" }} />
          <div className="skel skel--line" style={{ width: "85%" }} />
          <div className="skel skel--block" />
        </div>
      ) : error && isEmpty ? (
        <div className="card__body stack" style={{ gap: 12 }}>
          <div className="notice notice--warn">
            <span className="text">用量统计暂不可用（{error}），日志列表不受影响。</span>
          </div>
          <div>
            <Button variant="secondary" onClick={onRetry}>
              重试
            </Button>
          </div>
        </div>
      ) : isEmpty ? (
        <div className="card__body">
          <EmptyState icon={ScrollText} title="暂无用量数据" body="产生请求后，这里会按天和按模型汇总 token 用量。" />
        </div>
      ) : (
        <div className="card__body stack" style={{ gap: 20 }}>
          <div className="token-trio" style={{ flexWrap: "wrap" }}>
            <div className="token-stat"><div className="k">请求数</div><div className="v">{usageCount(totals.requestCount, approximate)}</div></div>
            <div className="token-stat"><div className="k">输入</div><div className="v">{usageCount(totals.promptTokens, approximate)}</div></div>
            <div className="token-stat"><div className="k">输出</div><div className="v">{usageCount(totals.completionTokens, approximate)}</div></div>
            <div className="token-stat"><div className="k">总计</div><div className="v">{usageCount(totals.totalTokens, approximate)}</div></div>
            <div className="token-stat"><div className="k">平均延迟</div><div className="v">{formatLatency(totals.avgLatencyMs)}</div></div>
          </div>
          <UsageTable caption="按天" keyLabel="日期" groups={dayGroups} approximate={approximate} showOkFail />
          <UsageTable caption="按模型" keyLabel="模型" groups={byModel} approximate={approximate} showOkFail />
          {approximate ? (
            <span style={{ fontSize: 12, color: "var(--muted)" }}>“约”表示该计数为近似值（后端采样或封顶计数）。</span>
          ) : null}
        </div>
      )}
    </section>
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
  const details = state?.details ?? [];
  const primary = details[0];
  const paired = details.length > 1;
  const titleId = paired
    ? (primary?.model ?? "Chat turn")
    : (state?.ids[0] ?? "Record");
  const started = details
    .map((d) => d.startedAt)
    .sort()[0];
  const latency = paired
    ? Math.max(...details.map((d) => d.latencyMs ?? 0))
    : primary?.latencyMs;
  const status = details.some((d) => d.status >= 400 || !d.ok)
    ? (details.find((d) => d.status >= 400 || !d.ok)?.status ?? 0)
    : (primary?.status ?? 0);

  return (
    <Modal open={state !== null} onClose={onClose} drawer labelledBy="drawer-id">
      {state ? (
        <div className="drawer">
          <div className="drawer__head">
            <div className="drawer__title">
              <span className="id" id="drawer-id">{titleId}</span>
              {primary ? (
                <span className="sub">
                  {formatTime(started ?? primary.startedAt)} · {formatLatency(latency)}
                  {paired ? " · 2 layers" : ""}
                </span>
              ) : null}
            </div>
            {primary ? <StatusPill status={status} /> : null}
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
            ) : details.length ? (
              <>
                {paired ? (
                  <p className="log-pair__intro">
                    One chat turn recorded two layers: the upstream provider call and the host-format stream yielded to Grok Bot.
                  </p>
                ) : null}
                {details.map((d) => (
                  <LogLayer key={d.id} detail={d} stacked={paired} />
                ))}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function LogLayer({ detail: d, stacked }: { detail: LogDetail; stacked: boolean }) {
  const requestValue = d.request ?? d.requestBody;
  const responseValue = d.response ?? d.responseBody;
  const requestRaw = rawBodyText(requestValue, d.requestFull);
  const responseRaw = rawBodyText(responseValue, d.responseFull);
  const requestMissing = isBodyMissing(d.hasRequest, requestValue);
  const responseMissing = isBodyMissing(d.hasResponse, responseValue);

  const body = (
    <>
      <div className="drawer-section">
        <span className="section-label">Overview</span>
        <div className="def-grid">
          <span className="k">Record</span>
          <span className="v mono">{d.id}</span>
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
          {d.clientName || d.clientVersion ? (
            <>
              <span className="k">Source</span>
              <span className="v">{[d.clientName, d.clientVersion].filter(Boolean).join(" ")}</span>
            </>
          ) : null}
          {d.conversationId ? (
            <>
              <span className="k">Conversation</span>
              <span className="v mono">{d.conversationId}</span>
            </>
          ) : null}
          {d.userAgent ? (
            <>
              <span className="k">User agent</span>
              <span className="v">{d.userAgent}</span>
            </>
          ) : null}
          {d.botName ? (
            <>
              <span className="k">Bot</span>
              <span className="v">{d.botName}</span>
            </>
          ) : null}
          {d.botId ? (
            <>
              <span className="k">Bot ID</span>
              <span className="v mono">{d.botId}</span>
            </>
          ) : null}
          {d.chatType ? (
            <>
              <span className="k">Chat source</span>
              <span className="v">
                {d.chatType === "group" ? "Group: " + (d.chatName ?? "—") : d.chatType === "dm" ? "Direct message" : "Routine"}
              </span>
            </>
          ) : null}
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
          <div className="drawer-section__head">
            <span className="section-label">Request body <span style={{ color: "var(--muted)", textTransform: "none", letterSpacing: 0 }}>· keys redacted</span></span>
            {d.hasRequest ? (
              <CopyButton
                label="Copy request payload"
                fullLabel="Request payload copied"
                text={() => getLog(d.id).then((fresh) => fullRequestText(fresh), () => requestRaw)}
              />
            ) : null}
          </div>
          <div className="code-pane">{requestMissing ? "报文不可用" : stringifyBody(requestValue)}</div>
          {d.requestTruncated ? <span style={{ fontSize: 12, color: "var(--muted)" }}>Body truncated by retention settings.</span> : null}
        </div>
      ) : null}

      {d.hasResponse ? (
        <div className="drawer-section">
          <div className="drawer-section__head">
            <span className="section-label">Response body <span style={{ color: "var(--muted)", textTransform: "none", letterSpacing: 0 }}>· redacted</span></span>
            {d.hasResponse ? (
              <CopyButton
                label="Copy response payload"
                fullLabel="Response payload copied"
                text={() => getLog(d.id).then((fresh) => fullResponseText(fresh), () => responseRaw)}
              />
            ) : null}
          </div>
          <div className="code-pane">{responseMissing ? "报文不可用" : stringifyBody(responseValue)}</div>
          {d.responseTruncated ? <span style={{ fontSize: 12, color: "var(--muted)" }}>Body truncated by retention settings.</span> : null}
        </div>
      ) : null}

      {!d.hasRequest && !d.hasResponse ? (
        <div className="notice notice--info">
          <span className="text">Bodies were not kept — recording keeps bodies on errors only by default.</span>
        </div>
      ) : null}
    </>
  );

  if (!stacked) return body;

  return (
    <section className="log-pair__layer" aria-label={channelSubtitle(d.channel)}>
      <div className="log-pair__layer-head">
        <LogChannelPair channels={[d.channel]} />
        <span className="log-channel__hint">{channelSubtitle(d.channel)}</span>
      </div>
      {body}
    </section>
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

/**
 * Raw clipboard text for a captured body — the exact content the server
 * returned, never the pretty-printed display form. Truncated bodies copy the
 * full redacted text when the record carries it, else the captured `preview`
 * string; no suffix is appended (the UI already shows the truncation notice).
 */
function rawBodyText(body: unknown, full?: unknown): string | null {
  if (body === null || body === undefined) return null;
  if (typeof body === "string") return body.length > 0 ? body : null;
  if (isTruncatedCapture(body)) {
    // Truncated records keep the full redacted text alongside the preview;
    // copy prefers it so the clipboard holds the complete body. Old rows
    // without it fall back to the preview.
    if (typeof full === "string" && full.length > 0) return full;
    return typeof body.preview === "string" && body.preview.length > 0 ? body.preview : null;
  }
  try {
    const text = JSON.stringify(body);
    return text === undefined ? null : text;
  } catch {
    return null;
  }
}

function isTruncatedCapture(
  body: unknown,
): body is { _truncated: boolean; preview: unknown } {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    (body as { _truncated?: unknown })._truncated === true
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall back to the legacy path below */
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    area.style.top = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

function CopyButton({ label, text, fullLabel }: { label: string; text: string | (() => Promise<string | null>); fullLabel?: string }) {
  const { pushToast } = useApp();
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const onCopy = async () => {
    const resolve = typeof text === "string" ? undefined : await text();
    const value = typeof text === "string" ? text : (resolve ?? null);
    if (value !== null && (await copyText(value))) {
      setCopied(true);
      pushToast("success", "Copied", fullLabel ?? label);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } else {
      pushToast("error", "Copy failed", value === null ? "The full body is not readable yet." : "Clipboard access was denied.");
    }
  };

  return (
    <button
      type="button"
      className={`copy-btn${copied ? " is-copied" : ""}`}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={() => void onCopy()}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </button>
  );
}
