import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  Database,
  Download,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  Trash2,
  TriangleAlert,
  Zap,
} from "lucide-react";
import {
  ApiError,
  fetchProviderModels,
  getModelCatalog,
  hasKey,
  refreshModelCatalog,
} from "../api/client";
import type {
  CatalogLookupModel,
  FetchModelsError,
  FetchModelsResult,
  FetchedModel,
  Model,
  ModelCatalog,
  Modality,
  Provider,
  ReasoningLevel,
  SaveResult,
} from "../api/types";
import { formatInteger, formatTime, formatTokens, reasoningListLabel } from "../lib/format";
import { enrichCatalogModels, modelImportFields } from "../lib/import-models";
import { navigate } from "../lib/router";
import { useApp, useBoxState } from "../store";
import { ImportModelsDialog } from "../components/ImportModelsDialog";
import { ModelDialog } from "../components/ModelDialog";
import { ConfirmDialog } from "../components/overlays";
import { EditProviderDialog, ReplaceKeyDialog } from "../components/ProviderDialogs";
import { Badge, Button, EmptyState, IconButton, ParamChip, Spinner } from "../components/ui";

function usedMessage(result: SaveResult): string {
  const model = result.models.find((m) => m.id === result.activeModelId);
  const base = model
    ? `Grok Bot will use ${model.slug} on the next message.`
    : "Model switched.";
  return result.wrapBytesChanged ? `${base} Grok Bot was restarted to apply the wrap.` : base;
}

export function Models({ providerId }: { providerId?: string }) {
  const state = useBoxState();
  const { save } = useApp();
  const providers = state.providers;

  const [selectedId, setSelectedId] = useState<string | null>(providerId ?? providers[0]?.id ?? null);
  const [editProvider, setEditProvider] = useState(false);
  const [replaceKey, setReplaceKey] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [modelDialog, setModelDialog] = useState<{ open: boolean; model: Model | null }>({ open: false, model: null });
  const [busy, setBusy] = useState<string | null>(null);

  // Source A fetch state
  const [fetching, setFetching] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [fetchResult, setFetchResult] = useState<FetchModelsResult | null>(null);
  const [fetchError, setFetchError] = useState<FetchModelsError | null>(null);
  const [catalogMatched, setCatalogMatched] = useState<Set<string>>(new Set());
  const [catalogLookup, setCatalogLookup] = useState<Map<string, CatalogLookupModel>>(new Map());

  // Source B catalog card
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);

  useEffect(() => {
    if (!selectedId && providers.length) setSelectedId(providers[0]?.id ?? null);
    if (selectedId && !providers.some((p) => p.id === selectedId)) {
      setSelectedId(providers[0]?.id ?? null);
    }
  }, [providers, selectedId]);

  const selected: Provider | undefined = providers.find((p) => p.id === selectedId);
  const models = useMemo(() => state.models.filter((m) => m.providerId === selectedId), [state.models, selectedId]);
  const active = state.models.find((m) => m.id === state.activeModelId);
  const selectedHasKey = selected ? hasKey(state, selected.id) : false;
  const existingSlugs = useMemo(() => new Set(models.map((m) => m.slug)), [models]);

  // Load Source B catalog status on mount
  useEffect(() => {
    let alive = true;
    getModelCatalog()
      .then((c) => {
        if (alive) setCatalog(c);
      })
      .catch(() => {
        /* catalog is optional */
      });
    return () => {
      alive = false;
    };
  }, []);

  const enrichCatalog = useCallback(async (fetched: FetchedModel[]) => {
    const { matched, lookup } = await enrichCatalogModels(fetched);
    setCatalogMatched(matched);
    setCatalogLookup(lookup);
  }, []);

  const doFetch = async (provider: Provider) => {
    setFetching(true);
    setFetchError(null);
    setFetchResult(null);
    try {
      const result = await fetchProviderModels(provider.id);
      setFetchResult(result);
      setCatalogMatched(new Set());
      setImportOpen(true);
      void enrichCatalog(result.models);
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError("Could not fetch models", { status: 500, fetchKind: "internal" });
      setFetchError({ error: { kind: e.fetchKind ?? "internal", message: e.message, upstreamStatus: e.upstreamStatus } });
      setFetchResult(null);
      setImportOpen(true);
    } finally {
      setFetching(false);
    }
  };

  const run = async (id: string, command: Parameters<typeof save>[0], opts: { title: string; message?: string | ((r: SaveResult) => string) }) => {
    setBusy(id);
    try {
      await save(command, { successTitle: opts.title, successMessage: opts.message });
      return true;
    } catch {
      return false;
    } finally {
      setBusy(null);
    }
  };

  const useModel = async (model: Model) => {
    if (!hasKey(state, model.providerId)) {
      setReplaceKey(true);
      return;
    }
    await run("use", { kind: "use-model", modelId: model.id }, { title: "Model switched", message: usedMessage });
  };

  const importModels = async (chosen: FetchedModel[]) => {
    for (const m of chosen) {
      const ok = await run(
        "import",
        {
          kind: "upsert-model",
          providerId: selected!.id,
          ...modelImportFields(m, catalogLookup.get(m.id)),
        },
        {
          title: "Models imported",
          message: chosen.length === 1
            ? `${m.id}${catalogMatched.has(m.id) ? " — fields auto-filled from catalog." : " — manual fields (no catalog match)."}`
            : undefined,
        },
      );
      if (!ok) break;
    }
  };

  const removeProvider = async () => {
    setConfirmRemove(false);
    if (!selected) return;
    const last = providers.length === 1;
    await run("remove", { kind: "remove-provider", providerId: selected.id }, {
      title: "Provider removed",
      message: last ? "Last provider removed. Chat is official Grok." : undefined,
    });
  };

  const refreshCatalog = async () => {
    setCatalogRefreshing(true);
    try {
      await refreshModelCatalog();
      // poll until ready/failed
      const poll = async () => {
        try {
          const c = await getModelCatalog();
          setCatalog(c);
          if (c.status === "loading") setTimeout(poll, 1500);
        } catch {
          setCatalogRefreshing(false);
        }
      };
      await poll();
    } catch {
      /* ignore */
    } finally {
      setCatalogRefreshing(false);
    }
  };

  if (!providers.length) {
    return (
      <section className="card card--pad">
        <EmptyState
          icon={Rocket}
          title="No providers yet"
          body="Add a provider to route Grok Bot through a custom model."
          action={
            <Button variant="primary" onClick={() => navigate({ kind: "setup" })}>
              Add provider
            </Button>
          }
        />
      </section>
    );
  }

  const activeProviderId = active?.providerId;

  const removeConsequences = (() => {
    if (!selected) return [];
    const last = providers.length === 1;
    const survivor = state.models.find((m) => m.id !== state.activeModelId && m.providerId !== selected.id);
    const list: string[] = [];
    if (last) {
      list.push("The box returns to Official Grok and the plan file is deleted.");
    } else if (survivor) {
      list.push(`The wildcard binding moves to ${survivor.slug}.`);
    }
    list.push("Its API key stays on disk (no delete path exists).");
    return list;
  })();

  return (
    <>
      <div className="page-title-row">
        <h1>Models</h1>
        <span className="sub">Providers, models, limits, and keys.</span>
      </div>

      <div className="master-detail">
        <aside className="provider-rail" aria-label="Providers">
          <div className="provider-rail__head">
            <span className="card__label">Providers · {providers.length}</span>
          </div>
          {providers.map((p) => (
            <button
              type="button"
              key={p.id}
              className={`provider-row${p.id === selectedId ? " is-selected" : ""}`}
              onClick={() => {
                setSelectedId(p.id);
                navigate({ kind: "models", providerId: p.id });
              }}
              aria-current={p.id === selectedId ? "true" : undefined}
            >
              <div className="provider-row__main">
                <div className="provider-row__name">
                  {p.name}
                  {p.id === activeProviderId ? <Zap aria-hidden="true" /> : null}
                </div>
                <div className="provider-row__origin">{p.origin}</div>
              </div>
              {hasKey(state, p.id) ? <Badge tone="success">Key</Badge> : <Badge tone="warning">No key</Badge>}
              <ChevronRight style={{ width: 14, height: 14, color: "var(--muted)" }} aria-hidden="true" />
            </button>
          ))}
          <div className="provider-rail__foot">
            <Button variant="secondary" style={{ width: "100%" }} onClick={() => navigate({ kind: "setup" })}>
              <Plus aria-hidden="true" />
              Add provider
            </Button>
          </div>
        </aside>

        {selected ? (
          <section className="card" aria-label={selected.name}>
            <div className="card__head">
              <div>
                <div className="row gap-2">
                  <span style={{ fontSize: 16, fontWeight: 600 }}>{selected.name}</span>
                  {selected.id === activeProviderId ? (
                    <Badge tone="accent" icon={Zap}>
                      Active
                    </Badge>
                  ) : null}
                </div>
                <div className="mono" style={{ fontSize: 12, color: "var(--muted)", marginTop: 2 }}>
                  {selected.origin}
                </div>
              </div>
              <div className="row gap-2 wrap">
                {selectedHasKey ? (
                  <Badge tone="success" icon={Check}>
                    Key saved
                  </Badge>
                ) : (
                  <Badge tone="warning" icon={TriangleAlert}>
                    No API key
                  </Badge>
                )}
                <Button variant="ghost-sm" icon={Download} loading={fetching} loadingLabel="Fetching…" onClick={() => void doFetch(selected)}>
                  Fetch models
                </Button>
                <Button variant="ghost-sm" icon={Pencil} onClick={() => setEditProvider(true)}>
                  Edit
                </Button>
                <Button variant="ghost-sm" icon={KeyRound} onClick={() => setReplaceKey(true)}>
                  {selectedHasKey ? "Replace key" : "Add key"}
                </Button>
                <Button variant="ghost-danger-sm" icon={Trash2} onClick={() => setConfirmRemove(true)}>
                  Remove
                </Button>
              </div>
            </div>

            {!selectedHasKey ? (
              <div className="card__body" style={{ paddingBottom: 12 }}>
                <div className="notice notice--warn">
                  <TriangleAlert aria-hidden="true" />
                  <span className="text">
                    This provider has no API key. Using a model here would fail with a 503 — add a key first.
                  </span>
                </div>
              </div>
            ) : null}

            <div className="card__body--flush table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Context</th>
                    <th className="num">Max output</th>
                    <th>Reasoning</th>
                    <th>Active</th>
                    <th>Modalities</th>
                    <th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((m) => {
                    const isActive = m.id === state.activeModelId;
                    return (
                      <tr key={m.id}>
                        <td>
                          <span className="mono">{m.slug}</span>{" "}
                          {isActive ? <Zap style={{ width: 12, height: 12, color: "var(--primary-strong)", verticalAlign: -2 }} aria-hidden="true" /> : null}
                        </td>
                        <td className="mono">{formatTokens(m.contextTokens)}</td>
                        <td className="num mono">{formatInteger(m.maxOutputTokens)}</td>
                        <td className="mono" style={{ color: "var(--muted)", fontSize: 11 }}>
                          {reasoningListLabel(m.reasoningLevels)}
                        </td>
                        <td>
                          <ParamChip isStatic>{m.activeReasoning}</ParamChip>
                        </td>
                        <td>{m.modalities.join(" · ")}</td>
                        <td style={{ textAlign: "right" }}>
                          {isActive ? (
                            <Badge tone="accent">Active</Badge>
                          ) : (
                            <Button variant="ghost-sm" onClick={() => void useModel(m)}>
                              Use
                            </Button>
                          )}{" "}
                          <IconButton label="Edit model" icon={Pencil} onClick={() => setModelDialog({ open: true, model: m })} />
                        </td>
                      </tr>
                    );
                  })}
                  {!models.length ? (
                    <tr>
                      <td colSpan={7}>
                        <div className="empty" style={{ padding: "24px 20px" }}>
                          <p>No models yet — add one manually or fetch the provider's list.</p>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="provider-rail__foot">
              <Button variant="ghost" icon={Plus} onClick={() => setModelDialog({ open: true, model: null })}>
                Add model
              </Button>
            </div>
          </section>
        ) : null}
      </div>

      {/* Source B catalog card */}
      <section className="card" aria-labelledby="h-catalog" style={{ marginTop: 16 }}>
        <div className="card__head">
          <span className="card__label" id="h-catalog">
            <Database style={{ width: 13, height: 13 }} aria-hidden="true" />
            Model catalog
          </span>
          <Button variant="ghost" icon={RefreshCw} loading={catalogRefreshing} loadingLabel="Refreshing…" onClick={() => void refreshCatalog()}>
            Refresh
          </Button>
        </div>
        <div className="card__body row" style={{ flexWrap: "wrap", gap: 12 }}>
          {catalog?.status === "loading" || catalogRefreshing ? (
            <Badge tone="warning">
              <Spinner size={11} />
              Loading
            </Badge>
          ) : catalog?.status === "failed" ? (
            <Badge tone="danger">Failed</Badge>
          ) : catalog?.status === "ready" ? (
            <Badge tone="success">Ready</Badge>
          ) : (
            <Badge>Unknown</Badge>
          )}
          <span className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>
            {catalog?.status === "ready" && catalog.lastFetched
              ? `Last fetched ${formatTime(catalog.lastFetched)} · ${catalog.totalModels ?? "—"} models · ${(catalog.sources ?? []).map((s) => s.name).join(" + ")}`
              : "Public model catalogs (openrouter + models.dev) for auto-fill."}
          </span>
        </div>
      </section>

      <EditProviderDialog
        open={editProvider}
        onClose={() => setEditProvider(false)}
        provider={selected ?? null}
        busy={busy === "provider"}
        onSave={async (name, origin) => {
          if (!selected) return;
          const ok = await run("provider", { kind: "update-provider", providerId: selected.id, name, origin }, { title: "Provider updated", message: `${name} now points to ${origin}.` });
          if (ok) setEditProvider(false);
        }}
      />

      <ReplaceKeyDialog
        open={replaceKey}
        onClose={() => setReplaceKey(false)}
        providerName={selected?.name ?? null}
        busy={busy === "secret"}
        onSave={async (secret) => {
          if (!selected) return;
          const ok = await run("secret", { kind: "set-secret", providerId: selected.id, secret }, { title: "Key saved", message: "Grok Bot will use the new key on the next message." });
          if (ok) setReplaceKey(false);
        }}
      />

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        onConfirm={removeProvider}
        title={`Remove ${selected?.name ?? ""}?`}
        description={`This provider and its ${models.length} model${models.length === 1 ? "" : "s"} will be removed.`}
        consequences={removeConsequences}
        confirmLabel="Remove provider"
        busy={busy === "remove"}
        icon={Trash2}
        iconTone="danger"
      />

      <ModelDialog
        open={modelDialog.open}
        onClose={() => setModelDialog({ open: false, model: null })}
        providerName={selected?.name ?? ""}
        existing={modelDialog.model}
        busy={busy === "model"}
        onSave={async (slug, limits) => {
          if (!selected) return;
          const ok = await run(
            "model",
            {
              kind: "upsert-model",
              providerId: selected.id,
              slug,
              contextTokens: limits.contextTokens,
              maxOutputTokens: limits.maxOutputTokens,
              reasoningLevels: limits.reasoningLevels as ReasoningLevel[],
              modalities: limits.modalities as Modality[],
              activeReasoning: limits.activeReasoning,
            },
            { title: "Model saved", message: `${slug} is available in the catalog.` },
          );
          if (ok) setModelDialog({ open: false, model: null });
        }}
      />

      <ImportModelsDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        providerName={selected?.name ?? ""}
        existingSlugs={existingSlugs}
        catalogMatched={catalogMatched}
        result={fetchResult}
        error={fetchError}
        onImport={importModels}
        onNoSecret={() => {
          setImportOpen(false);
          setReplaceKey(true);
        }}
      />
    </>
  );
}
