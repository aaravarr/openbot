import { useMemo, useState } from "react";
import { Check, Database, Download, Search, TriangleAlert, X } from "lucide-react";
import type { FetchModelsError, FetchModelsResult, FetchedModel } from "../api/types";
import { formatTokens } from "../lib/format";
import { Button } from "./ui";
import { Modal } from "./overlays";

type ImportModelsDialogProps = {
  open: boolean;
  onClose: () => void;
  providerName: string;
  existingSlugs: Set<string>;
  catalogMatched: Set<string>;
  result: FetchModelsResult | null;
  error: FetchModelsError | null;
  onImport: (models: FetchedModel[]) => Promise<void>;
  onNoSecret?: () => void;
};

function errorRemedy(kind: string | undefined): string {
  switch (kind) {
    case "no-secret":
      return "this provider has no API key. Add a key first, then retry.";
    case "unauthorized":
      return "the key was rejected — replace it, then retry.";
    case "not-supported":
      return "this provider exposes no /v1/models — add models manually.";
    case "provider-not-found":
      return "this provider no longer exists in the catalog.";
    case "parse-error":
      return "the upstream returned an unrecognized model list.";
    default:
      return "couldn't reach the provider — check the base URL and retry.";
  }
}

export function ImportModelsDialog({
  open,
  onClose,
  providerName,
  existingSlugs,
  catalogMatched,
  result,
  error,
  onImport,
  onNoSecret,
}: ImportModelsDialogProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const models = result?.models ?? [];
  const skipped = result?.skipped ?? 0;
  const skippedReasons = result?.skippedReasons ?? [];

  const rows = useMemo(() => {
    return models.map((m) => ({ model: m, exists: existingSlugs.has(m.id) }));
  }, [models, existingSlugs]);

  const selectable = useMemo(() => rows.filter((r) => !r.exists), [rows]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => `${r.model.id} ${r.model.name ?? ""}`.toLowerCase().includes(q));
  }, [rows, query]);

  const selectedCount = selectable.filter((r) => selected.has(r.model.id)).length;
  const allSelected = selectable.length > 0 && selectable.every((r) => selected.has(r.model.id));

  const hasError = error !== null;
  const isEmpty = !hasError && models.length === 0;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectable.map((r) => r.model.id)));
    }
  };

  const doImport = async () => {
    if (busy || selectedCount === 0) return;
    const chosen = models.filter((m) => selected.has(m.id));
    setBusy(true);
    try {
      await onImport(chosen);
      setSelected(new Set());
      onClose();
    } catch (err) {
      // onImport is expected to toast its own errors; keep the dialog open so
      // the user can retry instead of surfacing an unhandled rejection.
      console.error("Import failed:", err);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setSelected(new Set());
    setQuery("");
  };

  return (
    <Modal open={open} onClose={() => { reset(); onClose(); }} labelledBy="im-title">
      <div className="dialog dialog--import">
        <div className="import-head">
          <div className="import-head__top">
            <span className="dialog__icon dialog__icon--accent">
              <Download aria-hidden="true" />
            </span>
            <div className="import-head__titles">
              <div className="dialog__title" id="im-title">
                Import models
              </div>
              <div className="dialog__desc">Choose which of {providerName}'s models to add.</div>
            </div>
            <button className="icon-btn" aria-label="Close" onClick={() => { reset(); onClose(); }}>
              <X aria-hidden="true" />
            </button>
          </div>
          {!hasError && !isEmpty ? (
            <div className="import-toolbar">
              <span className="import-search">
                <Search aria-hidden="true" />
                <input
                  className="input"
                  type="text"
                  placeholder="Filter models"
                  aria-label="Filter models"
                  data-autofocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </span>
              <span className="import-count mono">{models.length} model{models.length === 1 ? "" : "s"}</span>
              <Button variant="secondary-sm" disabled={selectable.length === 0} onClick={toggleAll}>
                {allSelected ? "Select none" : "Select all"}
              </Button>
            </div>
          ) : null}
        </div>

        {skipped > 0 ? (
          <div className="import-notice">
            <div className="notice notice--warn">
              <TriangleAlert aria-hidden="true" />
              <span className="text">
                {skipped} of {models.length + skipped} models were skipped ({skippedReasons.join(", ") || "missing id"}).
                The valid models are still selectable.
              </span>
            </div>
          </div>
        ) : null}

        {hasError ? (
          <div className="import-error">
            <div className="notice notice--danger">
              <TriangleAlert aria-hidden="true" />
              <span className="text">
                <strong>{error.error.kind}</strong> — {errorRemedy(error.error.kind)}
                {error.error.upstreamStatus !== undefined ? ` (upstream ${error.error.upstreamStatus})` : ""}
              </span>
            </div>
            {error.error.kind === "no-secret" && onNoSecret ? (
              <Button variant="secondary" onClick={onNoSecret}>
                Add key first
              </Button>
            ) : null}
          </div>
        ) : isEmpty ? (
          <div className="import-empty">
            <div className="import-empty__tile">
              <Download aria-hidden="true" />
            </div>
            <h3>No models found</h3>
            <p>This provider returned an empty model list. Add models manually instead.</p>
          </div>
        ) : (
          <div className="import-body" role="group" aria-label="Fetched models">
            {filtered.map(({ model, exists }) => (
              <div className={`import-row${exists ? " is-added" : ""}`} key={model.id}>
                {exists ? (
                  <span className="tag tag--added">
                    <Check aria-hidden="true" />
                    Already added
                  </span>
                ) : (
                  <span className="checkbox">
                    <input
                      type="checkbox"
                      id={`im-${model.id}`}
                      checked={selected.has(model.id)}
                      onChange={() => toggle(model.id)}
                    />
                    <span className="checkbox__box">
                      <Check aria-hidden="true" />
                    </span>
                  </span>
                )}
                <label className="import-row__main" htmlFor={`im-${model.id}`}>
                  <span className="import-row__id">{model.id}</span>
                  {model.name ? <span className="import-row__name">{model.name}</span> : null}
                  {catalogMatched.has(model.id) ? (
                    <span className="badge badge--info">
                      <Database aria-hidden="true" />
                      catalog
                    </span>
                  ) : null}
                  {model.contextLength ? <span className="badge">{formatTokens(model.contextLength)}</span> : null}
                </label>
              </div>
            ))}
            {!filtered.length ? <div className="import-filter-empty">No models match your filter.</div> : null}
          </div>
        )}

        <div className="import-foot">
          <span className="import-selected">{selectedCount} selected</span>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={selectedCount === 0 || hasError || isEmpty}
            loading={busy}
            loadingLabel="Importing…"
            onClick={doImport}
          >
            Import selected ({selectedCount})
          </Button>
        </div>
      </div>
    </Modal>
  );
}
