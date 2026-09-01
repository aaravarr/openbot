import { go, type Route } from "./route";
import type { Provider } from "./api";

function IconChat() {
  return (
    <svg className="rail-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6.5L3.5 14v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function IconLogs() {
  return (
    <svg className="rail-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.5 3.5h9v9h-9z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path d="M5.5 6.5h5M5.5 9h3.5" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function IconProvider() {
  return (
    <svg className="rail-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.25" />
      <path d="M5 8h6M5 10.5h4" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function IconAdd() {
  return (
    <svg className="rail-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

export function Rail({
  providers,
  route,
  status,
  liveProviderId,
}: {
  providers: Provider[];
  route: Route;
  status: string;
  liveProviderId: string | null;
}) {
  const chatOn = route.kind === "chat";
  const logsOn = route.kind === "logs";
  const addOn = route.kind === "add";
  const activeProvider =
    route.kind === "provider" || route.kind === "model" ? route.providerId : "";

  return (
    <aside className="rail" aria-label="OpenBot">
      <div className="rail-brand">
        <p className="wordmark">OpenBot</p>
        <p className="rail-status">{status}</p>
      </div>
      <nav className="rail-nav" aria-label="Sections">
        <button
          type="button"
          className={chatOn ? "rail-item is-current" : "rail-item"}
          aria-current={chatOn ? "page" : undefined}
          onClick={() => go({ kind: "chat" })}
        >
          <span className="rail-item-main">
            <IconChat />
            <span className="rail-item-name">Chat</span>
          </span>
        </button>
        <button
          type="button"
          className={logsOn ? "rail-item is-current" : "rail-item"}
          aria-current={logsOn ? "page" : undefined}
          onClick={() => go({ kind: "logs" })}
        >
          <span className="rail-item-main">
            <IconLogs />
            <span className="rail-item-name">Logs</span>
          </span>
        </button>
        <p className="rail-label">Providers</p>
        {providers.map((provider) => {
          const current = activeProvider === provider.id;
          const on = liveProviderId === provider.id;
          return (
            <button
              key={provider.id}
              type="button"
              className={current ? "rail-item is-current" : "rail-item"}
              aria-current={current ? "page" : undefined}
              onClick={() => go({ kind: "provider", providerId: provider.id })}
            >
              <span className="rail-item-main">
                <IconProvider />
                <span className="rail-item-name">{provider.name}</span>
              </span>
              {on ? <span className="rail-on">On</span> : null}
            </button>
          );
        })}
        <button
          type="button"
          className={addOn ? "rail-item rail-add is-current" : "rail-item rail-add"}
          aria-current={addOn ? "page" : undefined}
          onClick={() => go({ kind: "add" })}
        >
          <span className="rail-item-main">
            <IconAdd />
            <span className="rail-item-name">Add provider</span>
          </span>
        </button>
      </nav>
    </aside>
  );
}
