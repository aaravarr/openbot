import { useCallback, useEffect, useId, useState } from "react";
import {
  clearLogs,
  getLog,
  listLogs,
  loadLogSettings,
  saveLogSettings,
  type LogDetail,
  type LogRecord,
  type LogSettings,
} from "./api";
import { ChipRadio } from "./ChipRadio";
import { Dialog } from "./Dialog";

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}

function snippet(text: string, max = 140): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…`;
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function truncatedNote(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as { _truncated?: unknown; _originalBytes?: unknown };
  if (row._truncated === true) {
    const bytes = typeof row._originalBytes === "number" ? row._originalBytes : undefined;
    return bytes !== undefined
      ? `This body was truncated (${String(bytes)} bytes original).`
      : "This body was truncated.";
  }
  return null;
}

export function Logs() {
  const searchId = useId();
  const filterId = useId();
  const [settings, setSettings] = useState<LogSettings | null>(null);
  const [days, setDays] = useState("7");
  const [items, setItems] = useState<LogRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "errors">("all");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<LogDetail | null>(null);

  const refreshSettings = useCallback(async () => {
    const next = await loadLogSettings();
    setSettings(next);
    setDays(String(next.logRetentionDays));
    return next;
  }, []);

  const refreshList = useCallback(async () => {
    const listed = await listLogs({
      q: q.trim() || undefined,
      ok: filter === "errors" ? false : undefined,
      page: 1,
      pageSize: 50,
    });
    setItems(listed.items);
    setTotal(listed.total);
  }, [filter, q]);

  useEffect(() => {
    void refreshSettings().catch((err: unknown) => {
      setNote(err instanceof Error ? err.message : "Could not load log settings");
      setNoteError(true);
    });
  }, [refreshSettings]);

  useEffect(() => {
    void refreshList().catch((err: unknown) => {
      setNote(err instanceof Error ? err.message : "Could not load logs");
      setNoteError(true);
    });
  }, [refreshList]);

  async function patch(next: LogSettings) {
    setBusy(true);
    setNote("");
    setNoteError(false);
    try {
      const saved = await saveLogSettings(next);
      setSettings(saved);
      setDays(String(saved.logRetentionDays));
      await refreshList();
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not save log settings");
      setNoteError(true);
    } finally {
      setBusy(false);
    }
  }

  async function saveDays() {
    if (!settings) {
      return;
    }
    const parsed = Number(days);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) {
      setNote("Keep for days must be an integer between 1 and 365.");
      setNoteError(true);
      setDays(String(settings.logRetentionDays));
      return;
    }
    if (parsed === settings.logRetentionDays) {
      return;
    }
    await patch({ ...settings, logRetentionDays: parsed });
  }

  async function openRow(id: string) {
    setOpenId(id);
    setDetail(null);
    try {
      setDetail(await getLog(id));
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not load this request");
      setNoteError(true);
      setOpenId(null);
    }
  }

  async function onClear() {
    setBusy(true);
    setNote("");
    setNoteError(false);
    try {
      await clearLogs();
      setOpenId(null);
      setDetail(null);
      await refreshList();
      setNote("Logs cleared.");
    } catch (err) {
      setNote(err instanceof Error ? err.message : "Could not clear logs");
      setNoteError(true);
    } finally {
      setBusy(false);
    }
  }

  const enabled = settings?.loggingEnabled === true;
  const emptyOff = settings !== null && !enabled && total === 0;
  const emptyOn = enabled && total === 0;

  return (
    <section className="logs" aria-labelledby="logs-title">
      <p className="kicker">Debug</p>
      <h1 className="display" id="logs-title">
        Logs
      </h1>
      <p className="lede">
        Hop request records for this Computer. Recording is off by default. Keys are never stored.
      </p>

      {settings ? (
        <div className="logs-settings">
          <label className="check-row check-row-main">
            <input
              type="checkbox"
              checked={settings.loggingEnabled}
              disabled={busy}
              onChange={(event) => {
                void patch({ ...settings, loggingEnabled: event.target.checked });
              }}
            />
            Record requests
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.logBodiesOnError}
              disabled={busy}
              onChange={(event) => {
                void patch({ ...settings, logBodiesOnError: event.target.checked });
              }}
            />
            Keep bodies on errors
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.logBodies}
              disabled={busy}
              onChange={(event) => {
                void patch({ ...settings, logBodies: event.target.checked });
              }}
            />
            Keep all bodies
          </label>
          <label className="field logs-days">
            Keep for (days)
            <input
              type="number"
              min={1}
              max={365}
              value={days}
              disabled={busy}
              onChange={(event) => setDays(event.target.value)}
              onBlur={() => {
                void saveDays();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.currentTarget.blur();
                }
              }}
            />
          </label>
        </div>
      ) : null}

      {note ? (
        <p className={noteError ? "fine error" : "fine"} role={noteError ? "alert" : "status"}>
          {note}
        </p>
      ) : null}

      <div className="logs-toolbar">
        <label className="field logs-search" htmlFor={searchId}>
          Search
          <input
            id={searchId}
            type="search"
            value={q}
            placeholder="id, model, error, provider"
            onChange={(event) => setQ(event.target.value)}
          />
        </label>
        <div>
          <p className="section-label" id={filterId}>
            Show
          </p>
          <ChipRadio
            labelledBy={filterId}
            value={filter}
            options={[
              { value: "all", label: "All" },
              { value: "errors", label: "Errors" },
            ]}
            onChange={(value) => setFilter(value === "errors" ? "errors" : "all")}
          />
        </div>
      </div>

      <div className="logs-actions">
        <button
          type="button"
          className="button-tertiary"
          disabled={busy}
          onClick={() => {
            void refreshList();
          }}
        >
          Refresh
        </button>
        <button type="button" className="button-danger" disabled={busy || total === 0} onClick={() => void onClear()}>
          Clear logs
        </button>
      </div>

      {emptyOff ? (
        <p className="page-foot">Recording is off. Nothing is stored until you enable Record requests.</p>
      ) : emptyOn ? (
        <p className="page-foot">No hop requests yet. Send a message in Grok Bot, then refresh this list.</p>
      ) : (
        <div className="list-card">
          {items.map((row) => (
            <button
              key={row.id}
              type="button"
              className="line log-line"
              onClick={() => {
                void openRow(row.id);
              }}
            >
              <span className="log-line-top">
                <span className="log-time">{formatTime(row.startedAt)}</span>
                {row.model ? (
                  <>
                    <span className="line-sep">·</span>
                    <span className="line-slug">{row.model}</span>
                  </>
                ) : null}
                <span className="line-sep">·</span>
                <span className={row.ok ? "log-status" : "log-status is-fail"}>{row.status}</span>
                {row.latencyMs !== undefined ? (
                  <>
                    <span className="line-sep">·</span>
                    <span className="log-latency">{row.latencyMs} ms</span>
                  </>
                ) : null}
              </span>
              {row.error ? <span className="log-error">{snippet(row.error)}</span> : null}
            </button>
          ))}
        </div>
      )}

      <Dialog
        title={detail?.model || "Request"}
        titleClassName="mono"
        className="dialog-log"
        open={openId !== null}
        onClose={() => {
          setOpenId(null);
          setDetail(null);
        }}
        aside={
          detail ? (
            <span className={detail.ok ? "badge" : "badge badge-warn"}>{detail.ok ? "ok" : "error"}</span>
          ) : undefined
        }
      >
        {detail ? (
          <div className="log-detail">
            <dl className="log-kv">
              <div>
                <dt>Time</dt>
                <dd>{formatTime(detail.startedAt)}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd className={detail.ok ? undefined : "error"}>{detail.status}</dd>
              </div>
              {detail.latencyMs !== undefined ? (
                <div>
                  <dt>Latency</dt>
                  <dd>{detail.latencyMs} ms</dd>
                </div>
              ) : null}
              {detail.providerName ? (
                <div>
                  <dt>Provider</dt>
                  <dd>{detail.providerName}</dd>
                </div>
              ) : null}
              {detail.upstreamEndpoint ? (
                <div>
                  <dt>Upstream</dt>
                  <dd className="mono">{detail.upstreamEndpoint}</dd>
                </div>
              ) : null}
              {detail.error ? (
                <div>
                  <dt>Error</dt>
                  <dd className="error">{detail.error}</dd>
                </div>
              ) : null}
              {detail.promptTokens !== undefined || detail.completionTokens !== undefined ? (
                <div>
                  <dt>Tokens</dt>
                  <dd>
                    {detail.promptTokens ?? "—"} / {detail.completionTokens ?? "—"}
                    {detail.totalTokens !== undefined ? ` · ${String(detail.totalTokens)} total` : ""}
                  </dd>
                </div>
              ) : null}
            </dl>
            {detail.requestTruncated || detail.responseTruncated ? (
              <p className="hint-soft">Part of this record was truncated to the capture limit.</p>
            ) : null}
            <p className="section-label">Request</p>
            {detail.hasRequest && detail.request !== undefined ? (
              <>
                {truncatedNote(detail.request) ? <p className="hint-soft">{truncatedNote(detail.request)}</p> : null}
                <pre className="log-json">{prettyJson(detail.request)}</pre>
              </>
            ) : (
              <p className="fine">No request body kept for this row.</p>
            )}
            <p className="section-label">Response</p>
            {detail.hasResponse && detail.response !== undefined ? (
              <>
                {truncatedNote(detail.response) ? <p className="hint-soft">{truncatedNote(detail.response)}</p> : null}
                <pre className="log-json">{prettyJson(detail.response)}</pre>
              </>
            ) : (
              <p className="fine">No response body kept for this row.</p>
            )}
          </div>
        ) : (
          <p className="fine">Loading…</p>
        )}
      </Dialog>
    </section>
  );
}
