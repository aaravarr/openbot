import { go, type Route } from "./route";
import type { Provider } from "./api";

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
          <span className="rail-item-name">Chat</span>
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
              <span className="rail-item-name">{provider.name}</span>
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
          <span className="rail-item-name">Add provider</span>
        </button>
      </nav>
    </aside>
  );
}
