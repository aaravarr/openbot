import { useEffect, useRef, useState } from "react";
import { Boxes, LayoutDashboard, ScrollText, Unplug } from "lucide-react";
import { Shell } from "./components/Shell";
import { ToastStack } from "./components/Toast";
import { Button } from "./components/ui";
import { parseHash, navigate, type Route } from "./lib/router";
import { AppProvider, useApp } from "./store";
import { Dashboard } from "./pages/Dashboard";
import { Logs } from "./pages/Logs";
import { Models } from "./pages/Models";
import { Setup } from "./pages/Setup";

function SkipLink() {
  return (
    <a className="skip-link" href="#main">
      Skip to content
    </a>
  );
}

function Unreachable({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <>
      <SkipLink />
      <main id="main" className="main" tabIndex={-1}>
        <div className="unreachable">
          <span className="unreachable__tile">
            <Unplug aria-hidden="true" />
          </span>
          <h1>Can't reach the openbot service…</h1>
          <p>Is the loopback service running on this Computer?</p>
          <span className="mono">{message}</span>
          <Button variant="secondary" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </main>
    </>
  );
}

function LoadingScreen() {
  return (
    <>
      <SkipLink />
      <div className="shell">
        <div className="topnav">
          <span className="brand">
            <span className="brand__mark" aria-hidden="true" />
            OpenBot
          </span>
        </div>
        <div className="status-strip" />
      </div>
      <main id="main" className="main" tabIndex={-1} aria-busy="true">
        <div className="grid grid--12">
          <div className="card card--pad col-8" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            <div className="skel skel--line" style={{ width: 70 }} />
            <div className="skel skel--line" style={{ width: 180, height: 20 }} />
            <div className="skel skel--line" style={{ width: 320 }} />
            <div className="skel skel--line" style={{ width: 220, height: 32 }} />
          </div>
          <div className="card col-4" style={{ paddingBottom: 8 }}>
            <div className="skel skel--row" />
            <div className="skel skel--row" />
            <div className="skel skel--row" />
          </div>
        </div>
      </main>
    </>
  );
}

function BottomTabs({ route, onNavigate }: { route: Route; onNavigate: (r: Route) => void }) {
  const items: { route: Route; label: string; icon: typeof LayoutDashboard }[] = [
    { route: { kind: "dashboard" }, label: "Dashboard", icon: LayoutDashboard },
    { route: { kind: "models" }, label: "Models", icon: Boxes },
    { route: { kind: "logs" }, label: "Logs", icon: ScrollText },
  ];
  const isActive = (r: Route): boolean => {
    if (r.kind === "models") return route.kind === "models" || route.kind === "setup";
    return route.kind === r.kind;
  };
  return (
    <nav className="bottom-tabs" aria-label="Primary">
      <div className="bottom-tabs__inner">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <a
              key={item.label}
              className={`bottom-tab${isActive(item.route) ? " is-active" : ""}`}
              href="#/"
              aria-current={isActive(item.route) ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                onNavigate(item.route);
              }}
            >
              <Icon aria-hidden="true" />
              {item.label}
            </a>
          );
        })}
      </div>
    </nav>
  );
}

function routeSignature(route: Route): string {
  if (route.kind === "models") return `models:${route.providerId ?? ""}`;
  if (route.kind === "logs") return `logs:${route.logId ?? ""}`;
  return route.kind;
}

function AppInner() {
  const { state, loadError, loading, refresh } = useApp();
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const mainRef = useRef<HTMLElement | null>(null);
  const firstRender = useRef(true);

  useEffect(() => {
    const onHash = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const signature = routeSignature(route);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [signature]);

  useEffect(() => {
    const title =
      route.kind === "dashboard"
        ? "Dashboard"
        : route.kind === "models"
          ? "Models"
          : route.kind === "setup"
            ? "Setup"
            : "Logs";
    document.title = `${title} · OpenBot`;
  }, [signature, route.kind]);

  // Auto-redirect to setup when the catalog is empty and the box is official.
  useEffect(() => {
    if (!state) return;
    const empty = state.providers.length === 0;
    const official = state.snapshot.alignment.desired === "official";
    if (empty && official && (route.kind === "dashboard" || route.kind === "logs")) {
      navigate({ kind: "setup" });
    }
  }, [state, route.kind]);

  if (!state) {
    if (loading) return <LoadingScreen />;
    return <Unreachable message={loadError ?? "Could not load OpenBot"} onRetry={() => void refresh()} />;
  }

  let page;
  if (route.kind === "models") {
    page = <Models providerId={route.providerId} />;
  } else if (route.kind === "setup") {
    page = <Setup />;
  } else if (route.kind === "logs") {
    page = <Logs logId={route.logId} />;
  } else {
    page = <Dashboard />;
  }

  return (
    <>
      <SkipLink />
      <Shell route={route} onNavigate={navigate} />
      <main ref={mainRef} id="main" className="main" tabIndex={-1}>
        {page}
      </main>
      <BottomTabs route={route} onNavigate={navigate} />
      <ToastStack />
    </>
  );
}

export function App() {
  return (
    <AppProvider>
      <AppInner />
    </AppProvider>
  );
}
