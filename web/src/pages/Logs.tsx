import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
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
  getBots,
  listLogs,
  listEvents,
  stripLogBodies,
} from "../api/client";
import type {
  LogChannel,
  LogChannelFilter,
  LogDetail,
  LogEvent,
  LogFacets,
  LogInjectionMetadata,
  LogInjectionStats,
  LogRecord,
  LogStats,
  LogUsage,
  LogUsageRow,
  BotInfo,
} from "../api/types";
import { LogChannelPair } from "../components/LogChannel";
import { channelSubtitle, formatLatency, formatTime, formatTimestamp } from "../lib/format";
import { botDisplayName } from "../lib/bot-label";
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

function pairInjection(pair: LogRowPair<LogRecord>): LogInjectionMetadata | undefined {
  if (pair.kind === "single") return pair.record.injection;
  return pair.hop.injection ?? pair.harness.injection;
}

function injectionFacetLabel(value: string): string {
  return value
    .replace(/^l([123])\./, "L$1 · ")
    .replace(/-/g, " ");
}

function injectionOutcome(metadata: LogInjectionMetadata): { label: string; tone: "success" | "warning" | "danger" | "info" | "neutral" } {
  const outcome = metadata.l2Outcome;
  if (outcome === "second-success" || outcome === "applied" || outcome === "success" || outcome === "retry-success") {
    return { label: "Remediated", tone: "success" };
  }
  if (outcome === "fallback-original-terminal" || metadata.terminalDecision === "l2-fallback-original-terminal") {
    return { label: "Fallback · original", tone: "danger" };
  }
  if (outcome === "failed") return { label: "Remediation failed", tone: "danger" };
  if (outcome === "unresolved" || outcome === "valid-no-tool") return { label: "Unresolved", tone: "warning" };
  if (metadata.skipReason) return { label: `Skipped · ${injectionFacetLabel(metadata.skipReason)}`, tone: "neutral" };
  if (metadata.classificationSkippedReason) return { label: `Classification · ${injectionFacetLabel(metadata.classificationSkippedReason)}`, tone: "warning" };
  if (metadata.injectionWouldApply === true || metadata.l2Eligible === true) return { label: "Candidate", tone: "info" };
  return { label: "Observed", tone: "neutral" };
}

function injectionBadgeClass(tone: ReturnType<typeof injectionOutcome>["tone"]): string {
  return tone === "success" ? "badge--success" : tone === "danger" ? "badge--danger" : tone === "warning" ? "badge--warning" : tone === "info" ? "badge--info" : "";
}

function injectionCell(pair: LogRowPair<LogRecord>): ReactNode {
  const metadata = pairInjection(pair);
  if (!metadata) return "—";
  const outcome = injectionOutcome(metadata);
  const family = metadata.injectionFamilies?.[0];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span className={`badge ${injectionBadgeClass(outcome.tone)}`}>{outcome.label}</span>
      {family ? <span className="cell-sub">{injectionFacetLabel(family)}</span> : null}
    </span>
  );
}

function InjectionFacetList({ label, values }: { label: string; values: Array<{ value: string; count: number }> }): ReactNode {
  if (values.length === 0) return null;
  return (
    <div className="drawer-section" style={{ marginTop: 0 }}>
      <span className="section-label">{label}</span>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {values.map((item) => (
          <span className="badge" key={item.value}>
            <span className="mono">{item.value}</span>
            <span aria-label={"Records: " + item.count}>×{item.count}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function InjectionStatsCard({ stats, approximate }: { stats: LogInjectionStats; approximate: boolean }): ReactNode {
  return (
    <section className="card logs-injection" aria-label="Injection hardening telemetry" style={{ marginTop: 12 }}>
      <div className="card__head">
        <span className="card__label"><ShieldCheck aria-hidden="true" /> Injection hardening</span>
        <span className="sub">{stats.records} metadata record{stats.records === 1 ? "" : "s"}{approximate ? " · sampled" : ""}</span>
      </div>
      <div className="card__body stack" style={{ gap: 14 }}>
        <div className="token-trio" style={{ flexWrap: "wrap" }}>
          <div className="token-stat"><div className="k">Candidates</div><div className="v">{stats.candidates}</div></div>
          <div className="token-stat"><div className="k">Remediated</div><div className="v">{stats.applied}</div></div>
          <div className="token-stat"><div className="k">Fallbacks</div><div className="v">{stats.fallbackOriginalTerminal}</div></div>
          <div className="token-stat"><div className="k">Extra calls</div><div className="v">{stats.extraCalls}</div></div>
          <div className="token-stat"><div className="k">Extra latency</div><div className="v">{formatLatency(stats.extraLatencyMs)}</div></div>
          <div className="token-stat"><div className="k">Skipped</div><div className="v">{stats.skipped}</div></div>
          <div className="token-stat"><div className="k">Parse/classification</div><div className="v">{stats.classificationSkipped}</div></div>
        </div>
        <div className="stack" style={{ gap: 10 }}>
          <InjectionFacetList label="Families" values={stats.families} />
          <InjectionFacetList label="Skip reasons" values={stats.skipReasons} />
          <InjectionFacetList label="Classification skips" values={stats.classificationSkippedReasons} />
          <InjectionFacetList label="Outcomes" values={stats.outcomes} />
        </div>
      </div>
    </section>
  );
}

export function Logs({ logId, page: routePage }: { logId?: string; page?: number }) {
  const state = useBoxState();
  const { pushToast } = useApp();

  const [page, setPage] = useState(() => (routePage !== undefined && routePage >= 1 ? routePage : 1));
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

  const [records, setRecords] = useState<LogRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [channelFilter, setChannelFilter] = useState<LogChannelFilter | "">("");
  const [modelFilter, setModelFilter] = useState<string | null>(null);
  const [botFilter, setBotFilter] = useState<string | null>(null);
  const [chatTypeFilter, setChatTypeFilter] = useState<"group" | "dm" | "routine" | "">("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [drawer, setDrawer] = useState<DrawerState | null>(null);
  const [drawerLoading, setDrawerLoading] = useState(false);

  const [activeTab, setActiveTab] = useState<"requests" | "events" | "usage">("requests");
  const [usage, setUsage] = useState<LogUsage | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageRange, setUsageRange] = useState<"1h" | "6h" | "24h" | "7d" | "30d">("24h");
  const [stats, setStats] = useState<LogStats | null>(null);
  const [facets, setFacets] = useState<LogFacets | null>(null);
  const [bots, setBots] = useState<BotInfo[]>([]);
  const [events, setEvents] = useState<LogEvent[]>([]);
  const [eventsTotal, setEventsTotal] = useState(0);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [severityFilter, setSeverityFilter] = useState("");
  const [confirmStrip, setConfirmStrip] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);

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
  const botNames = useMemo(() => new Map(bots.map((bot) => [bot.botId, bot.botName])), [bots]);
  const botFilterOptions = useMemo(() => {
    const seen = new Map<string, { name: string; deleted: boolean }>();
    for (const bot of bots) seen.set(bot.botId, { name: bot.botName, deleted: bot.deleted });
    for (const bot of facets?.bots ?? []) {
      if (bot.botId && !seen.has(bot.botId)) seen.set(bot.botId, { name: bot.botName ?? bot.botId, deleted: true });
    }
    for (const record of records) {
      if (record.botId && !seen.has(record.botId)) seen.set(record.botId, { name: record.botName ?? record.botId, deleted: true });
    }
    const live = [...seen.entries()]
      .filter(([, bot]) => !bot.deleted)
      .sort((a, b) => a[1].name.localeCompare(b[1].name, undefined, { sensitivity: "base" }));
    const loggedIds = new Set([...(facets?.bots ?? []).map((bot) => bot.botId).filter((id): id is string => Boolean(id)), ...records.map((row) => row.botId).filter((id): id is string => Boolean(id))]);
    const deleted = [...seen.entries()]
      .filter(([botId, bot]) => bot.deleted && loggedIds.has(botId))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([botId]) => ({ value: botId, label: `Deleted · ${botId}` }));
    return [{ label: "Bot", options: [{ value: "", label: "All bots" }, ...live.map(([botId, bot]) => ({ value: botId, label: bot.name })), ...deleted] }];
  }, [bots, facets, records]);
  // The source column only appears once the backend stamps source fields; older
  // rows render without it instead of a column of dashes.
  const hasSourceColumn = useMemo(() => records.some(hasSource), [records]);
  // Keep legacy/off-mode tables unchanged; metadata enables this column for all
  // pages once the stats endpoint confirms that at least one row has telemetry.
  const hasInjectionColumn = Boolean(stats?.injection);
  const tableColumnCount = 8 + (hasSourceColumn ? 1 : 0) + (hasInjectionColumn ? 1 : 0);

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
        botId: botFilter ?? undefined,
        chatType: chatTypeFilter || undefined,
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
  }, [q, errorsOnly, channelFilter, modelFilter, botFilter, chatTypeFilter, page, pageSize, goToPage]);

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
    getBots().then(setBots).catch(() => { /* old log rows still render from their snapshot */ });
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
      setUsage(await fetchLogUsage({ range: usageRange }));
    } catch (err) {
      setUsageError(err instanceof Error ? err.message : "Could not load usage.");
    } finally {
      setUsageLoading(false);
    }
  }, [usageRange]);
 
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

  const botGroups: ListboxGroup[] = botFilterOptions;

  const chatTypeGroups: ListboxGroup[] = useMemo(
    () => [{
      label: "Source type",
      options: [
        { value: "", label: "All sources" },
        { value: "group", label: "Group chat" },
        { value: "dm", label: "Direct message" },
        { value: "routine", label: "routine" },
      ],
    }],
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

  const logSettings = state.logSettings;
  const recordingOff = !logSettings.loggingEnabled;
  const turnCount = pairs.length;
  const openId = drawer?.ids[0];

  return (
    <>
      <div className="page-title-row">
        <h1>Logs</h1>
        <span className="sub">One custom turn is an upstream call plus a harness stream — not two events.</span>
      </div>

      {/* Recording settings are edited on the Settings page; this page reads them. */}
      <section className="card logs-stats" aria-label="Recording settings" style={{ marginBottom: 16 }}>
        <div className="logs-stats__row">
          <span className="logs-stats__item">
            <span className="k">Recording</span>
            <span className="v">{logSettings.loggingEnabled ? "On" : "Off"}</span>
          </span>
          <span className="logs-stats__item">
            <span className="k">Bodies</span>
            <span className="v">{logSettings.logBodies ? "All requests" : "Errors only"}</span>
          </span>
          <span className="logs-stats__item">
            <span className="k">Retention</span>
            <span className="v">{logSettings.logRetentionDays} days</span>
          </span>
          <span className="logs-stats__spacer" />
          <a
            href="#/settings"
            className="row gap-1"
            style={{ fontSize: 12, fontWeight: 500 }}
            onClick={(e) => {
              e.preventDefault();
              navigate({ kind: "settings" });
            }}
          >
            <Settings2 style={{ width: 13, height: 13 }} aria-hidden="true" />
            Manage in Settings
          </a>
        </div>
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
      {stats?.injection ? <InjectionStatsCard stats={stats.injection} approximate={stats.approximate} /> : null}

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
        <RichUsageSection
          usage={usage}
          loading={usageLoading}
          error={usageError}
          range={usageRange}
          onRangeChange={(next) => { setUsageRange(next); setUsage(null); }}
          onRetry={() => void loadUsage()}
        />
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
          <Listbox
            label="Filter by bot"
            groups={botGroups}
            value={botFilter ?? ""}
            onChange={(v) => {
              setBotFilter(v || null);
              resetToFirstPage();
            }}
            triggerStyle={{ height: 30 }}
          />
          <Listbox
            label="Filter by source"
            groups={chatTypeGroups}
            value={chatTypeFilter}
            onChange={(v) => {
              setChatTypeFilter(v === "group" || v === "dm" || v === "routine" ? v : "");
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
                {hasInjectionColumn ? <th>Injection</th> : null}
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
                    <td colSpan={tableColumnCount} style={{ padding: 0 }}><div className="skel skel--row" /></td>
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
                          {pairSourceLabel(pair, botNames) ?? "—"}
                        </td>
                      ) : null}
                      {hasInjectionColumn ? <td data-label="Injection">{injectionCell(pair)}</td> : null}
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
                  <td colSpan={tableColumnCount}>
                    <EmptyState
                      icon={ScrollText}
                      title="Recording is off"
                      body="Turn on recording to capture future turns. Requests made before recording was enabled are not recoverable."
                      action={
                        <Button variant="primary" onClick={() => navigate({ kind: "settings" })}>
                          Turn on recording
                        </Button>
                      }
                    />
                  </td>
                </tr>
              ) : (
                <tr className="row-empty">
                  <td colSpan={tableColumnCount}>
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
        botNames={botNames}
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
  return Boolean(r.botId || r.botName || r.chatType || r.chatName || r.clientName || r.clientVersion || r.conversationId || r.userAgent);
}
 
/** Short source label for list rows; prefers client name, then conversation, then UA. */
function sourceLabel(r: LogRecord, botNames?: ReadonlyMap<string, string>): ReactNode {
  const bot = botDisplayName(r, botNames ?? new Map());
  if (r.chatType === "group") {
    const chat = r.chatName?.trim();
    if (chat && bot) return `${chat} - ${bot}`;
    if (chat) return chat;
    if (bot) return bot;
  }
  if (r.chatType === "dm") return bot || "Direct message";
  if (r.chatType === "routine") {
    return bot ? <>{bot} <span style={{ color: "var(--muted)", fontSize: 11 }}>(routine)</span></> : "routine";
  }
  if (bot) return bot;
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
 
function pairSourceLabel(pair: LogRowPair<LogRecord>, botNames: ReadonlyMap<string, string>): ReactNode {
  for (const member of pairMembers(pair)) {
    const label = sourceLabel(member, botNames);
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
    const key = pick(row).trim() || "Unknown";
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
  return `${approximate ? "Approx. " : ""}${value.toLocaleString("en-US")}`;
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
              <th className="num">Requests</th>
              {showOkFail ? <th className="num">Success</th> : null}
              {showOkFail ? <th className="num">Failures</th> : null}
              <th className="num">Input</th>
              <th className="num">Output</th>
              <th className="num">Total</th>
              <th className="num">Avg latency</th>
              {showFirstToken ? <th className="num">First token</th> : null}
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
 
type UsageRange = "1h" | "6h" | "24h" | "7d" | "30d";
type UsageSummary = LogUsageRow & { successRate: number; cacheHitRate: number };

function usageSummaryFallback(rows: LogUsageRow[]): UsageSummary {
  const summary: UsageSummary = { key: "summary", requests: 0, ok: 0, fail: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, reasoningTokens: 0, avgLatencyMs: 0, avgFirstTokenMs: undefined, avgTps: undefined, successRate: 0, cacheHitRate: 0 };
  for (const row of rows) {
    summary.requests += row.requests; summary.ok += row.ok; summary.fail += row.fail;
    summary.promptTokens += row.promptTokens; summary.completionTokens += row.completionTokens;
    summary.totalTokens += row.totalTokens; summary.cachedTokens += row.cachedTokens; summary.reasoningTokens += row.reasoningTokens;
  }
  summary.successRate = summary.requests ? summary.ok / summary.requests : 0;
  summary.cacheHitRate = summary.promptTokens ? summary.cachedTokens / summary.promptTokens : 0;
  return summary;
}

function RichUsageSection({ usage, loading, error, range, onRangeChange, onRetry }: { usage: LogUsage | null; loading: boolean; error: string | null; range: UsageRange; onRangeChange: (range: UsageRange) => void; onRetry: () => void }) {
  const dayRows = usage?.byDay ?? []; const modelRows = usage?.byModel ?? [];
  const summary = usage?.summary ?? usageSummaryFallback(dayRows);
  const ranges: Array<[UsageRange, string]> = [["1h", "1h"], ["6h", "6h"], ["24h", "24h"], ["7d", "7d"], ["30d", "30d"]];
  const empty = !usage || summary.requests === 0;
  return <section className="card usage-board" aria-label="Usage dashboard">
    <div className="card__head logs-toolbar usage-board__head"><div><span className="card__label">Usage</span><span className="usage-board__hint">Based on recorded requests</span></div><div className="usage-range" role="tablist" aria-label="Time range">{ranges.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={range === key} className={range === key ? "is-active" : ""} onClick={() => onRangeChange(key)}>{label}</button>)}</div><IconButton label="Refresh usage" icon={RefreshCw} onClick={onRetry} /></div>
    {loading && empty ? <div className="card__body"><div className="skel skel--block" /></div> : error && empty ? <div className="card__body stack"><div className="notice notice--warn"><span className="text">Usage statistics unavailable: {error}</span></div><Button variant="secondary" onClick={onRetry}>Retry</Button></div> : empty ? <div className="card__body"><EmptyState icon={ScrollText} title="No usage data yet" body="Usage, latency, and model distribution will appear after requests are recorded." /></div> : <div className="card__body usage-board__body">
      <UsageSummaryCards summary={summary} approximate={usage?.approximate === true} />
      <UsageTrend buckets={usage?.buckets ?? []} />
      <div className="usage-board__split"><UsageDonut title="Token breakdown" items={[{ label: "Input (uncached)", value: Math.max(0, summary.promptTokens - summary.cachedTokens), color: "#6f9f9a" }, { label: "Cached", value: summary.cachedTokens, color: "#9fbbe0" }, { label: "Output", value: summary.completionTokens, color: "#d49a63" }, { label: "Reasoning", value: summary.reasoningTokens, color: "#c0a8dd" }]} /><UsageBars title="Model distribution" rows={modelRows.map(toUsageGroup)} /></div>
      <UsageTable caption="By day" keyLabel="Date" groups={dayRows.map(toUsageGroup)} approximate={usage?.approximate === true} showOkFail /><UsageTable caption="By model" keyLabel="Model" groups={modelRows.map(toUsageGroup)} approximate={usage?.approximate === true} showOkFail /><span className="usage-board__note">Avg TPS is calculated as completion tokens ÷ (end-to-end latency − first-token latency); estimated cost is not yet connected to a price table.</span>
    </div>}
  </section>;
}

function UsageSummaryCards({ summary, approximate }: { summary: UsageSummary; approximate: boolean }) {
  const cards = [["Requests", `${usageCount(summary.requests, approximate)} (success ${summary.ok} / failures ${summary.fail})`], ["Success rate", `${(summary.successRate * 100).toFixed(1)}%`], ["Avg latency", formatLatency(summary.avgLatencyMs)], ["Avg TTFT", formatLatency(summary.avgFirstTokenMs)], ["Avg TPS", summary.avgTps ? `${summary.avgTps.toFixed(1)} tok/s` : "—"], ["Total tokens", usageCount(summary.totalTokens, approximate)], ["Input tokens", usageCount(summary.promptTokens, approximate)], ["Output tokens", usageCount(summary.completionTokens, approximate)], ["Cached tokens", usageCount(summary.cachedTokens, approximate)], ["Cache hit rate", `${(summary.cacheHitRate * 100).toFixed(1)}%`], ["Reasoning tokens", usageCount(summary.reasoningTokens, approximate)]] as const;
  return <div className="usage-metrics">{cards.map(([label, value]) => <div className="usage-metric" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>;
}

function UsageTrend({ buckets }: { buckets: LogUsageRow[] }) {
  const width = 720, height = 220, pad = 28; const max = Math.max(1, ...buckets.map((b) => b.promptTokens + b.completionTokens)); const maxReq = Math.max(1, ...buckets.map((b) => b.requests));
  return <div className="usage-chart"><div className="usage-chart__title"><span>Token trend</span><span className="usage-legend">Input · Cached · Output · Reasoning · <em>● Requests</em></span></div>{buckets.length ? <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Token trend chart" className="usage-svg">{buckets.map((b, index) => { const x = pad + index * ((width - pad * 2) / buckets.length); const bw = Math.max(4, (width - pad * 2) / buckets.length - 3); let y = height - pad; const parts = [[Math.max(0, b.promptTokens - b.cachedTokens), "#6f9f9a"], [b.cachedTokens, "#9fbbe0"], [b.completionTokens, "#d49a63"], [b.reasoningTokens, "#c0a8dd"]] as const; const rects = parts.map(([value, color]) => { const h = value / max * (height - pad * 2); y -= h; return <rect key={color} x={x} y={y} width={bw} height={h} fill={color} />; }); const cy = height - pad - b.requests / maxReq * (height - pad * 2); return <g key={b.key}>{rects}<circle cx={x + bw / 2} cy={cy} r="2.5" fill="#f54e00" />{index % Math.max(1, Math.ceil(buckets.length / 6)) === 0 ? <text x={x + bw / 2} y={height - 8} textAnchor="middle">{b.key.slice(11, 16)}</text> : null}</g>; })}</svg> : <div className="usage-chart__empty">No trend data for the current range</div>}</div>;
}

function UsageDonut({ title, items }: { title: string; items: Array<{ label: string; value: number; color: string }> }) { let cursor = 0; const total = items.reduce((sum, item) => sum + item.value, 0); const background = total ? `conic-gradient(${items.map((item) => { const start = cursor / total * 360; cursor += item.value; return `${item.color} ${start}deg ${cursor / total * 360}deg`; }).join(", ")})` : "var(--surface-2)"; return <div className="usage-panel"><div className="usage-chart__title">{title}</div><div className="usage-donut-row"><div className="usage-donut" style={{ background }}><strong>{total.toLocaleString("en-US")}</strong><small>tokens</small></div><div className="usage-key">{items.map((item) => <div key={item.label}><i style={{ background: item.color }} />{item.label}<b>{total ? `${(item.value / total * 100).toFixed(1)}%` : "0%"}</b></div>)}</div></div></div>; }
function UsageBars({ title, rows }: { title: string; rows: UsageGroup[] }) { const max = Math.max(1, ...rows.map((row) => row.totalTokens)); return <div className="usage-panel"><div className="usage-chart__title">{title}</div><div className="usage-bars">{rows.slice(0, 8).map((row) => <div key={row.key}><span title={row.key}>{row.key}</span><div><i style={{ width: `${row.totalTokens / max * 100}%` }} /></div><b>{row.totalTokens.toLocaleString("en-US")}</b></div>)}</div></div>; }

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
    () => (dayRows.length === 0 && legacyRows.length > 0 ? groupUsage(legacyRows, (row) => row.key || "Unknown") : []),
    [dayRows.length, legacyRows],
  );
  const byDay = useMemo(() => dayRows.map(toUsageGroup), [dayRows]);
  const byModel = useMemo(() => modelRows.map(toUsageGroup), [modelRows]);
  const dayGroups = byDay.length > 0 ? byDay : legacyByDay;
  const isEmpty = dayGroups.length === 0 && byModel.length === 0;

  return (
    <section className="card" aria-label="Token usage">
      <div className="card__head logs-toolbar">
        <span className="card__label">Usage{approximate ? " (approx.)" : ""}</span>
        <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
          By day / by model{approximate ? " (approx.)" : ""}
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
            <span className="text">Usage statistics unavailable ({error}); the log list is unaffected.</span>
          </div>
          <div>
            <Button variant="secondary" onClick={onRetry}>
              Retry
            </Button>
          </div>
        </div>
      ) : isEmpty ? (
        <div className="card__body">
          <EmptyState icon={ScrollText} title="No usage data yet" body="Usage will be summarized by day and model after requests are recorded." />
        </div>
      ) : (
        <div className="card__body stack" style={{ gap: 20 }}>
          <div className="token-trio" style={{ flexWrap: "wrap" }}>
            <div className="token-stat"><div className="k">Requests</div><div className="v">{usageCount(totals.requestCount, approximate)}</div></div>
            <div className="token-stat"><div className="k">Input</div><div className="v">{usageCount(totals.promptTokens, approximate)}</div></div>
            <div className="token-stat"><div className="k">Output</div><div className="v">{usageCount(totals.completionTokens, approximate)}</div></div>
            <div className="token-stat"><div className="k">Total</div><div className="v">{usageCount(totals.totalTokens, approximate)}</div></div>
            <div className="token-stat"><div className="k">Avg latency</div><div className="v">{formatLatency(totals.avgLatencyMs)}</div></div>
          </div>
          <UsageTable caption="By day" keyLabel="Date" groups={dayGroups} approximate={approximate} showOkFail />
          <UsageTable caption="By model" keyLabel="Model" groups={byModel} approximate={approximate} showOkFail />
          {approximate ? (
            <span style={{ fontSize: 12, color: "var(--muted)" }}>“Approx.” indicates an estimated count (backend sampling or capped counting).</span>
          ) : null}
        </div>
      )}
    </section>
  );
}
 
function LogDrawer({
  state,
  loading,
  botNames,
  onClose,
}: {
  state: DrawerState | null;
  loading: boolean;
  botNames: ReadonlyMap<string, string>;
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
                  <LogLayer key={d.id} detail={d} stacked={paired} botNames={botNames} />
                ))}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function injectionDetailValue(value: string | number | boolean | undefined): string {
  if (value === undefined) return "—";
  return typeof value === "boolean" ? (value ? "true" : "false") : String(value);
}

function InjectionDetails({ metadata }: { metadata: LogInjectionMetadata }): ReactNode {
  const outcome = injectionOutcome(metadata);
  const families = metadata.injectionFamilies?.map(injectionFacetLabel).join(" · ");
  const emitted = metadata.deliveryCallsEmitted?.length;
  const observed = metadata.deliveryObserved?.length;
  const deliveryErrors = metadata.deliveryErrorsObserved?.length;
  return (
    <div className="drawer-section">
      <div className="drawer-section__head">
        <span className="section-label">Injection decision</span>
        <span className={`badge ${injectionBadgeClass(outcome.tone)}`}>{outcome.label}</span>
      </div>
      <div className="def-grid">
        <span className="k">Mode</span><span className="v mono">{metadata.injectionMode ?? "—"}</span>
        <span className="k">Family</span><span className="v">{families ?? "—"}</span>
        <span className="k">Identity gate</span><span className="v mono">{metadata.identityGateResult ?? "—"}</span>
        {metadata.skipReason ? <><span className="k">Skip reason</span><span className="v mono">{metadata.skipReason}</span></> : null}
        {metadata.classificationSkippedReason ? <><span className="k">Classification skip</span><span className="v mono">{metadata.classificationSkippedReason}</span></> : null}
        <span className="k">Would apply</span><span className="v mono">{injectionDetailValue(metadata.injectionWouldApply)}</span>
        <span className="k">L2 eligible</span><span className="v mono">{injectionDetailValue(metadata.l2Eligible)}</span>
        <span className="k">L2 attempted</span><span className="v mono">{injectionDetailValue(metadata.l2Attempted)}</span>
        <span className="k">L2 outcome</span><span className="v mono">{metadata.l2Outcome ?? "—"}</span>
        <span className="k">Nudge shape</span><span className="v mono">{metadata.l2NudgeShape ?? "—"}</span>
        <span className="k">Extra calls</span><span className="v mono">{injectionDetailValue(metadata.l2AdditionalRuns)}</span>
        <span className="k">Extra latency</span><span className="v mono">{formatLatency(metadata.l2AddedLatencyMs)}</span>
        <span className="k">Current response tools</span><span className="v mono">{injectionDetailValue(metadata.currentResponseToolCallCount)}</span>
        <span className="k">Debt</span><span className="v mono">{metadata.debtState ?? "—"}{metadata.debtShape ? ` · ${metadata.debtShape}` : ""}</span>
        <span className="k">Touch</span><span className="v mono">{metadata.touchClassification ?? "—"}</span>
        <span className="k">Tools after touch</span><span className="v mono">{injectionDetailValue(metadata.toolCallsAfterLastTouch)}</span>
        <span className="k">Terminal decision</span><span className="v mono">{metadata.terminalDecision ?? "—"}</span>
        <span className="k">Terminal hold</span><span className="v mono">{metadata.terminalHoldState ?? "—"} · {metadata.heldTerminalBytes ?? 0} bytes</span>
        {metadata.hostDeliveryEventMode ? <><span className="k">Host events</span><span className="v mono">{metadata.hostDeliveryEventMode}</span></> : null}
        {emitted !== undefined ? <><span className="k">Call-emitted</span><span className="v mono">{emitted}</span></> : null}
        {observed !== undefined ? <><span className="k">Delivery observed</span><span className="v mono">{observed}</span></> : null}
        {deliveryErrors !== undefined ? <><span className="k">Delivery errors</span><span className="v mono">{deliveryErrors}</span></> : null}
        {metadata.latestRealUserMessageId ? <><span className="k">Latest user message</span><span className="v mono">{metadata.latestRealUserMessageId}</span></> : null}
        {metadata.injectionFingerprint ? <><span className="k">Fingerprint</span><span className="v mono">{metadata.injectionFingerprint}</span></> : null}
        {metadata.firstResponseHash ? <><span className="k">First response hash</span><span className="v mono">{metadata.firstResponseHash}</span></> : null}
        {metadata.l2BodyHash ? <><span className="k">L2 body hash</span><span className="v mono">{metadata.l2BodyHash}</span></> : null}
      </div>
    </div>
  );
}

function LogLayer({ detail: d, stacked, botNames }: { detail: LogDetail; stacked: boolean; botNames: ReadonlyMap<string, string> }) {
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
          {(d.botName || d.botId) ? (
            <>
              <span className="k">Bot</span>
              <span className="v">{botDisplayName(d, botNames)}</span>
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

      {d.injection ? <InjectionDetails metadata={d.injection} /> : null}

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
          <div className="code-pane">{requestMissing ? "Payload unavailable" : stringifyBody(requestValue)}</div>
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
          <div className="code-pane">{responseMissing ? "Payload unavailable" : stringifyBody(responseValue)}</div>
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
