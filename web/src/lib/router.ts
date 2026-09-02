/** Hash router: 3 pages + #/setup. Unknown/dangling routes fall back to #/. */

export type Route =
  | { kind: "dashboard" }
  | { kind: "models"; providerId?: string }
  | { kind: "setup" }
  | { kind: "logs"; logId?: string };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [pathPart = "", queryPart = ""] = raw.split("?");
  const query = new URLSearchParams(queryPart);
  const segments = pathPart.split("/").filter(Boolean);

  if (segments.length === 0 || segments[0] === "") {
    return { kind: "dashboard" };
  }
  switch (segments[0]) {
    case "models": {
      const providerId = segments[1] ? decodeURIComponent(segments[1]) : undefined;
      return { kind: "models", providerId };
    }
    case "setup":
      return { kind: "setup" };
    case "logs": {
      const logId = query.get("id") ?? undefined;
      return { kind: "logs", logId };
    }
    default:
      return { kind: "dashboard" };
  }
}

export function toHash(route: Route): string {
  switch (route.kind) {
    case "dashboard":
      return "#/";
    case "models":
      return route.providerId ? `#/models/${encodeURIComponent(route.providerId)}` : "#/models";
    case "setup":
      return "#/setup";
    case "logs":
      return route.logId ? `#/logs?id=${encodeURIComponent(route.logId)}` : "#/logs";
  }
}

export function navigate(route: Route): void {
  const next = toHash(route);
  if (window.location.hash === next) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  window.location.hash = next;
}
