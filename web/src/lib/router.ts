/** Hash router: 3 pages + #/setup. Unknown/dangling routes fall back to #/. */

export type Route =
  | { kind: "dashboard" }
  | { kind: "models"; providerId?: string }
  | { kind: "setup" }
  | { kind: "logs"; logId?: string; page?: number };

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
      const pageRaw = query.get("page");
      const pageNum = pageRaw === null ? NaN : Number(pageRaw);
      const page = Number.isInteger(pageNum) && pageNum >= 1 ? pageNum : undefined;
      return { kind: "logs", logId, page };
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
    case "logs": {
      const params = new URLSearchParams();
      if (route.logId) params.set("id", route.logId);
      if (route.page !== undefined && route.page > 1) params.set("page", String(route.page));
      const suffix = params.toString();
      return suffix ? `#/logs?${suffix}` : "#/logs";
    }
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
