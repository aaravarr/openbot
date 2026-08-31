import { useCallback, useEffect, useState } from "react";
import {
  hostBlocked,
  isCustom,
  keyedSet,
  loadState,
  modelById,
  providerById,
  save,
  type BoxState,
  type Command,
} from "./api";
import { Chat } from "./Chat";
import { ModelPage } from "./ModelPage";
import { ProviderPage } from "./ProviderPage";
import { Rail } from "./Rail";
import { Setup, type ProviderDraft } from "./Setup";
import { go, paneKind, parseHash, type Route } from "./route";
import { labelReasoning, type ModelLimits } from "./model";

type Toast = { text: string; error: boolean };

export function App() {
  const [state, setState] = useState<BoxState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [focusProviderId, setFocusProviderId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  const refresh = useCallback(async () => {
    try {
      const next = await loadState();
      setState(next);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load OpenBot");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!state || state.providers.length === 0) {
      return;
    }
    const current = parseHash(window.location.hash);
    if (current.kind === "provider" && !providerById(state, current.providerId)) {
      go({ kind: "chat" });
      return;
    }
    if (current.kind === "model") {
      const owner = providerById(state, current.providerId);
      const row = modelById(state, current.modelId);
      if (!owner || !row || row.providerId !== current.providerId) {
        go({ kind: "chat" });
      }
    }
  }, [state]);

  async function run(id: string, command: Command, ok: (next: BoxState) => string): Promise<BoxState> {
    setBusyId(id);
    setFormError("");
    try {
      const next = await save(command);
      setState(next);
      setToast({ text: ok(next), error: false });
      return next;
    } catch (err) {
      const text = err instanceof Error ? err.message : "Something went wrong";
      setFormError(text);
      setToast({ text, error: true });
      throw err;
    } finally {
      setBusyId(null);
    }
  }

  function useModelCommand(modelId: string, reasoning?: string): Command {
    if (reasoning === undefined) {
      return { kind: "use-model", modelId };
    }
    return { kind: "use-model", modelId, reasoning };
  }

  function usedMessage(next: BoxState): string {
    const model = modelById(next, next.activeModelId);
    if (!model) {
      return "Model switched.";
    }
    if (model.activeReasoning && model.activeReasoning !== "none") {
      return `Grok Bot will use ${model.slug} (${labelReasoning(model.activeReasoning)}) on the next message.`;
    }
    return `Grok Bot will use ${model.slug} on the next message.`;
  }

  async function connect(draft: ProviderDraft) {
    await run(
      "connect",
      {
        kind: "upsert-provider",
        name: draft.name.trim(),
        origin: draft.origin.trim(),
        modelSlug: draft.modelSlug.trim(),
        secret: draft.secret,
      },
      usedMessage,
    );
    go({ kind: "chat" });
  }

  function needKey(providerId: string) {
    setFocusProviderId(providerId);
    go({ kind: "provider", providerId });
  }

  async function useChosen(modelId: string, reasoning?: string) {
    const current = state;
    if (!current) {
      return;
    }
    const model = modelById(current, modelId);
    if (model && !keyedSet(current).has(model.providerId)) {
      needKey(model.providerId);
      return;
    }
    await run("use", useModelCommand(modelId, reasoning), usedMessage);
  }

  if (loadError && !state) {
    return (
      <div className="first-run">
        <p className="wordmark first-run-brand">OpenBot</p>
        <section className="setup">
          <h1 className="display">Cannot reach OpenBot</h1>
          <p className="lede error">{loadError}</p>
          <div className="form-actions">
            <button type="button" className="button-primary" onClick={() => void refresh()}>
              Try again
            </button>
          </div>
        </section>
      </div>
    );
  }

  if (!state) {
    return (
      <div className="first-run" aria-busy="true">
        <p className="wordmark first-run-brand">OpenBot</p>
        <section className="setup">
          <p className="kicker">OpenBot</p>
          <h1 className="display">Loading…</h1>
          <p className="lede">Checking this Computer.</p>
        </section>
      </div>
    );
  }

  const custom = isCustom(state);
  const empty = state.providers.length === 0;
  const blocked = hostBlocked(state);
  const busy = busyId !== null;
  const active = modelById(state, state.activeModelId);
  const liveProviderId = custom && active ? active.providerId : null;
  const status = custom
    ? active
      ? active.activeReasoning && active.activeReasoning !== "none"
        ? `${active.slug} · ${labelReasoning(active.activeReasoning)}`
        : active.slug
      : "Your model"
    : "Official Grok";

  if (empty) {
    return (
      <>
        <div className="first-run">
          <p className="wordmark first-run-brand">OpenBot</p>
          {blocked ? (
            <p className="banner" role="alert">
              {blocked}
            </p>
          ) : null}
          <Setup busy={busyId === "connect"} error={formError} onSubmit={connect} />
        </div>
        {toast ? (
          <div className={toast.error ? "toast toast-error" : "toast"} role="status">
            {toast.text}
          </div>
        ) : null}
      </>
    );
  }

  const pane = paneKind(route);
  const provider =
    route.kind === "provider" || route.kind === "model"
      ? providerById(state, route.providerId)
      : undefined;
  const model = route.kind === "model" ? modelById(state, route.modelId) : undefined;
  const missing = (route.kind === "provider" && !provider) || (route.kind === "model" && (!provider || !model));
  const shown: Route = missing ? { kind: "chat" } : route;
  const shownPane = missing ? "chat" : pane;

  function back() {
    if (shown.kind === "model" && provider) {
      go({ kind: "provider", providerId: provider.id });
      return;
    }
    go({ kind: "chat" });
  }

  let body;
  if (shown.kind === "add") {
    body = (
      <Setup
        compact
        busy={busyId === "connect"}
        error={formError}
        onSubmit={connect}
        onCancel={() => go({ kind: "chat" })}
      />
    );
  } else if (shown.kind === "provider" && provider) {
    body = (
      <ProviderPage
        key={provider.id}
        state={state}
        provider={provider}
        busy={busy}
        focusKey={focusProviderId === provider.id}
        onAddModel={async (providerId, slug) => {
          await run(
            "model",
            { kind: "upsert-model", providerId, slug },
            () => `Added ${slug}.`,
          );
        }}
        onSetSecret={async (providerId, secret) => {
          setFocusProviderId(null);
          await run("secret", { kind: "set-secret", providerId, secret }, () => "API key saved.");
        }}
        onRemove={async (providerId) => {
          await run("remove", { kind: "remove-provider", providerId }, (next) =>
            next.providers.length ? "Provider removed." : "Last provider removed. Chat is official Grok.",
          );
          go({ kind: "chat" });
        }}
        onUse={(modelId) => {
          void useChosen(modelId);
        }}
      />
    );
  } else if (shown.kind === "model" && provider && model) {
    body = (
      <ModelPage
        key={model.id}
        provider={provider}
        model={model}
        busy={busy}
        isOn={custom && state.activeModelId === model.id}
        onSave={async (providerId, slug, limits: ModelLimits) => {
          await run(
            "model",
            {
              kind: "upsert-model",
              providerId,
              slug,
              contextTokens: limits.contextTokens,
              maxOutputTokens: limits.maxOutputTokens,
              reasoningLevels: limits.reasoningLevels,
              modalities: limits.modalities,
            },
            () => `Saved ${slug}.`,
          );
        }}
        onUse={(modelId) => {
          void useChosen(modelId);
        }}
      />
    );
  } else {
    body = (
      <Chat
        state={state}
        busy={busy}
        onOfficial={() => {
          void run("official", { kind: "official" }, () => "Chat is back on official Grok.");
        }}
        onUse={(modelId, reasoning) => {
          void useChosen(modelId, reasoning);
        }}
        onNeedKey={needKey}
      />
    );
  }

  return (
    <>
      <div className="shell" data-pane={shownPane}>
        <Rail providers={state.providers} route={shown} status={status} liveProviderId={liveProviderId} />
        <div className="pane-wrap">
          <main className="pane" id="main">
            {shownPane !== "chat" ? (
              <button type="button" className="pane-back" onClick={back}>
                Back
              </button>
            ) : null}
            {blocked ? (
              <p className="banner" role="alert">
                {blocked}
              </p>
            ) : null}
            {body}
          </main>
        </div>
      </div>
      {toast ? (
        <div className={toast.error ? "toast toast-error" : "toast"} role="status">
          {toast.text}
        </div>
      ) : null}
    </>
  );
}
