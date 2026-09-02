import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ApiError, loadState, save as apiSave, healthz } from "./api/client";
import type { BoxState, Command, SaveResult } from "./api/types";
import { refusalKindLabel, refusalRemedy } from "./lib/refusal";

export type ToastKind = "success" | "error" | "info";
export type Toast = { id: number; kind: ToastKind; title: string; message?: string };

type SaveOpts = {
  successTitle?: string;
  successMessage?: string | ((result: SaveResult) => string);
  errorTitle?: string;
};

type AppStore = {
  state: BoxState | null;
  loadError: string | null;
  loading: boolean;
  saving: boolean;
  service: { ok: boolean; latencyMs?: number };
  toasts: Toast[];
  theme: "light" | "dark";
  toggleTheme: () => void;
  refresh: () => Promise<void>;
  save: (command: Command, opts?: SaveOpts) => Promise<SaveResult>;
  pushToast: (kind: ToastKind, title: string, message?: string) => void;
  dismissToast: (id: number) => void;
  consumeLoadError: () => void;
};

const Ctx = createContext<AppStore | null>(null);

const THEME_KEY = "openbot-theme";

function systemTheme(): "light" | "dark" {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function readTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* ignore */
  }
  return systemTheme();
}

function friendlyMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.refusal) {
      return `${refusalKindLabel(err.refusal)} — ${refusalRemedy(err.refusal)}`;
    }
    return err.message;
  }
  return err instanceof Error ? err.message : "Something went wrong";
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BoxState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingCount, setSavingCount] = useState(0);
  const [service, setService] = useState<{ ok: boolean; latencyMs?: number }>({ ok: false });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [theme, setTheme] = useState<"light" | "dark">(readTheme);
  const saveTail = useRef<Promise<void>>(Promise.resolve());
  const toastId = useRef(0);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const pushToast = useCallback((kind: ToastKind, title: string, message?: string) => {
    const id = ++toastId.current;
    setToasts((prev) => [...prev, { id, kind, title, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await loadState();
      setState(next);
      setLoadError(null);
    } catch (err) {
      setLoadError(friendlyMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let alive = true;
    const ping = async () => {
      const started = performance.now();
      try {
        await healthz();
        if (alive) setService({ ok: true, latencyMs: Math.round(performance.now() - started) });
      } catch {
        if (alive) setService({ ok: false });
      }
    };
    const loop = () => {
      void ping();
      void refresh();
    };
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") loop();
    }, 30_000);
    void ping();
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [refresh]);

  const save = useCallback((command: Command, opts: SaveOpts = {}): Promise<SaveResult> => {
    const run = async (): Promise<SaveResult> => {
      setSavingCount((n) => n + 1);
      try {
        const result = await apiSave(command);
        setState(result);
        const msg =
          typeof opts.successMessage === "function" ? opts.successMessage(result) : opts.successMessage;
        pushToast("success", opts.successTitle ?? "Saved", msg);
        return result;
      } catch (err) {
        const text = friendlyMessage(err);
        pushToast("error", opts.errorTitle ?? "Save failed", text);
        throw err;
      } finally {
        setSavingCount((n) => Math.max(0, n - 1));
      }
    };
    const queued = saveTail.current.then(run, run);
    saveTail.current = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }, [pushToast]);

  const value = useMemo<AppStore>(
    () => ({
      state,
      loadError,
      loading,
      saving: savingCount > 0,
      service,
      toasts,
      theme,
      toggleTheme: () => setTheme((t) => (t === "dark" ? "light" : "dark")),
      refresh,
      save,
      pushToast,
      dismissToast,
      consumeLoadError: () => setLoadError(null),
    }),
    [state, loadError, loading, savingCount, service, toasts, theme, refresh, save, pushToast, dismissToast],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppStore {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}

/** Non-null state accessor for page components (App guarantees state is loaded first). */
export function useBoxState(): BoxState {
  const ctx = useContext(Ctx);
  if (!ctx || !ctx.state) throw new Error("useBoxState must be used with a loaded AppProvider");
  return ctx.state;
}
