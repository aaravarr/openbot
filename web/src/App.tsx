import { useCallback, useEffect, useState } from "react";
import {
  hostBlocked,
  isCustom,
  loadState,
  modelById,
  save,
  type BoxState,
  type Command,
} from "./api";
import { Hero } from "./Hero";
import { Providers } from "./Providers";
import { Setup, type ProviderDraft } from "./Setup";
import { Switcher } from "./Switcher";

type Toast = { text: string; error: boolean };

export function App() {
  const [state, setState] = useState<BoxState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState("");
  const [adding, setAdding] = useState(false);
  const [focusProviderId, setFocusProviderId] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);

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
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 4200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!focusProviderId) {
      return;
    }
    const node = document.getElementById(`provider-${focusProviderId}`);
    node?.scrollIntoView({ behavior: "smooth", block: "center" });
    const timer = window.setTimeout(() => setFocusProviderId(null), 2400);
    return () => window.clearTimeout(timer);
  }, [focusProviderId]);

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
      (next) => {
        const model = modelById(next, next.activeModelId);
        return model
          ? `Grok Bot will use ${model.slug} on the next message.`
          : "Provider saved. Send a new message in Grok Bot.";
      },
    );
    setAdding(false);
  }

  if (loadError && !state) {
    return (
      <>
        <Header label="Offline" />
        <main>
          <section className="hero-card">
            <h2 className="now-title">Cannot reach OpenBot</h2>
            <p className="now-body error">{loadError}</p>
            <div className="now-actions">
              <button type="button" className="button-primary" onClick={() => void refresh()}>
                Try again
              </button>
            </div>
          </section>
        </main>
      </>
    );
  }

  if (!state) {
    return (
      <>
        <Header label="Loading" />
        <main>
          <section className="hero-card" aria-busy="true">
            <p className="kicker">OpenBot</p>
            <h2 className="now-title">Loading…</h2>
            <p className="now-body">Checking this Computer.</p>
          </section>
        </main>
      </>
    );
  }

  const custom = isCustom(state);
  const empty = state.providers.length === 0;
  const blocked = hostBlocked(state);
  const status = custom
    ? modelById(state, state.activeModelId)?.slug || "Your model"
    : "Official Grok";

  return (
    <>
      <Header label={status} />
      <main>
        {blocked ? (
          <p className="banner error" role="alert">
            {blocked}
          </p>
        ) : null}

        {empty ? (
          <Setup
            busy={busyId === "connect"}
            error={formError}
            onSubmit={connect}
          />
        ) : (
          <>
            <Hero
              state={state}
              busy={busyId === "official" || busyId === "resume"}
              onOfficial={() => {
                void run("official", { kind: "official" }, () => "Chat is back on official Grok.");
              }}
              onResume={(modelId) => {
                void run("resume", { kind: "use-model", modelId }, (next) => {
                  const model = modelById(next, next.activeModelId);
                  return model
                    ? `Grok Bot will use ${model.slug} on the next message.`
                    : "Custom model is on.";
                });
              }}
            />
            <Switcher
              state={state}
              busyId={busyId}
              onOfficial={() => {
                void run("official", { kind: "official" }, () => "Chat is back on official Grok.");
              }}
              onUse={(modelId) => {
                void run("use", { kind: "use-model", modelId }, (next) => {
                  const model = modelById(next, next.activeModelId);
                  return model
                    ? `Grok Bot will use ${model.slug} on the next message.`
                    : "Model switched.";
                });
              }}
              onNeedKey={(providerId) => setFocusProviderId(providerId)}
            />
            <Providers
              state={state}
              busyId={busyId}
              focusProviderId={focusProviderId}
              onAddModel={async (providerId, slug) => {
                await run("model", { kind: "upsert-model", providerId, slug }, () => `Added ${slug}.`);
              }}
              onSetSecret={async (providerId, secret) => {
                await run("secret", { kind: "set-secret", providerId, secret }, () => "API key saved.");
              }}
              onRemove={async (providerId) => {
                await run("remove", { kind: "remove-provider", providerId }, (next) =>
                  next.providers.length ? "Provider removed." : "Last provider removed. Chat is official Grok.",
                );
              }}
              onUse={(modelId) => {
                void run("use", { kind: "use-model", modelId }, (next) => {
                  const model = modelById(next, next.activeModelId);
                  return model
                    ? `Grok Bot will use ${model.slug} on the next message.`
                    : "Model switched.";
                });
              }}
            />
            {adding ? (
              <Setup
                compact
                busy={busyId === "connect"}
                error={formError}
                onSubmit={connect}
                onCancel={() => setAdding(false)}
              />
            ) : (
              <button type="button" className="button-secondary add-another" onClick={() => setAdding(true)}>
                Add provider
              </button>
            )}
          </>
        )}
        <p className="page-foot">Keys stay on this Computer. Open Grok Bot and send a new message after you switch.</p>
      </main>
      {toast ? (
        <div className={toast.error ? "toast toast-error" : "toast"} role="status">
          {toast.text}
        </div>
      ) : null}
    </>
  );
}

function Header({ label }: { label: string }) {
  return (
    <header className="top-nav">
      <h1 className="wordmark">OpenBot</h1>
      <p className="nav-status">{label}</p>
    </header>
  );
}
