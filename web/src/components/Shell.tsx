import { useState } from "react";
import {
  Boxes,
  ChevronRight,
  Copy,
  LayoutDashboard,
  Moon,
  ScrollText,
  ShieldAlert,
  Sun,
} from "lucide-react";
import { hostBlocked } from "../api/client";
import { deriveHealth } from "../lib/health";
import { refusalDetail, refusalKindLabel, refusalRemedy } from "../lib/refusal";
import type { Route } from "../lib/router";
import { useApp } from "../store";
import { HealthDot, IconButton, ModePill, Spinner } from "./ui";

export function Shell({ route, onNavigate }: { route: Route; onNavigate: (r: Route) => void }) {
  const { state, saving, service, theme, toggleTheme, pushToast } = useApp();
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  if (!state) return null;

  const mode = state.snapshot.alignment.desired;
  const active = state.models.find((m) => m.id === state.activeModelId);
  const blocked = hostBlocked(state);
  const health = deriveHealth(state, service);
  const worst = health.find((h) => h.state === "fault");

  const copyLoopback = async () => {
    try {
      await navigator.clipboard.writeText("http://127.0.0.1:9280");
      pushToast("info", "Copied", "http://127.0.0.1:9280");
    } catch {
      pushToast("error", "Copy failed", "Clipboard access was denied.");
    }
  };

  const navItems: { route: Route; label: string; icon: typeof LayoutDashboard }[] = [
    { route: { kind: "dashboard" }, label: "Dashboard", icon: LayoutDashboard },
    { route: { kind: "models" }, label: "Models", icon: Boxes },
    { route: { kind: "logs" }, label: "Logs", icon: ScrollText },
  ];

  const isActive = (r: Route): boolean => {
    if (r.kind === "models") return route.kind === "models" || route.kind === "setup";
    return route.kind === r.kind;
  };

  return (
    <header className="shell">
      <div className="topnav">
        <a className="brand" href="#/" onClick={(e) => { e.preventDefault(); onNavigate({ kind: "dashboard" }); }}>
          <span className="brand__mark">
            <ChevronRight aria-hidden="true" />
          </span>
          OpenBot
        </a>
        <nav className="nav" aria-label="Primary">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                type="button"
                className={`nav__link${isActive(item.route) ? " is-active" : ""}`}
                aria-current={isActive(item.route) ? "page" : undefined}
                onClick={() => onNavigate(item.route)}
              >
                <Icon aria-hidden="true" />
                {item.label}
              </button>
            );
          })}
        </nav>
        <div className="topnav__right">
          <span className="loopback-chip">
            <span className="dot-live" aria-hidden="true" />
            127.0.0.1:9280
            <button type="button" aria-label="Copy loopback URL" onClick={copyLoopback}>
              <Copy aria-hidden="true" />
            </button>
          </span>
          <IconButton
            label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
            icon={theme === "dark" ? Moon : Sun}
            onClick={toggleTheme}
          />
        </div>
      </div>

      <div className="status-strip">
        <ModePill mode={mode} model={active?.slug} />
        <div className="health-cluster">
          {health.map((h) => (
            <span className={`health-item${h.state === "fault" ? " is-fault" : ""}`} key={h.word}>
              <HealthDot state={h.state} label={h.label} />
              <span className="word">{h.word}</span>
              <span className="val">{h.value}</span>
            </span>
          ))}
        </div>
        <div className="status-strip__right">
          {saving ? (
            <span className="saving-pill">
              <Spinner size={12} />
              Saving…
            </span>
          ) : null}
        </div>
      </div>

      {blocked ? (
        <div className="blocked-banner" role="alert">
          <span className="blocked-banner__icon">
            <ShieldAlert aria-hidden="true" />
          </span>
          <div className="blocked-banner__body">
            <span className="blocked-banner__kind">{refusalKindLabel(blocked)}</span>
            <div className="blocked-banner__remedy">
              {refusalRemedy(blocked)} All changes are disabled.{" "}
              <button className="link" type="button" onClick={() => setShowDiagnostics((s) => !s)}>
                {showDiagnostics ? "Hide diagnostics" : "View diagnostics"}
              </button>
            </div>
            {showDiagnostics ? (
              <pre className="blocked-banner__diag">
                {JSON.stringify({ wrap: state.snapshot.wrap, worst: worst?.label }, null, 2)}
                {refusalDetail(blocked) ? `\n${refusalDetail(blocked)}` : ""}
              </pre>
            ) : null}
          </div>
        </div>
      ) : null}
    </header>
  );
}
