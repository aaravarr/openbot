export type Route =
  | { kind: "chat" }
  | { kind: "add" }
  | { kind: "provider"; providerId: string }
  | { kind: "model"; providerId: string; modelId: string };

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#/, "").replace(/^\/+/, "");
  if (!raw || raw === "chat") {
    return { kind: "chat" };
  }
  if (raw === "add") {
    return { kind: "add" };
  }
  const parts = raw.split("/");
  if (parts[0] === "p" && parts[1]) {
    const providerId = decodeURIComponent(parts[1]);
    if (parts[2] === "m" && parts[3]) {
      return {
        kind: "model",
        providerId,
        modelId: decodeURIComponent(parts.slice(3).join("/")),
      };
    }
    return { kind: "provider", providerId };
  }
  return { kind: "chat" };
}

export function toHash(route: Route): string {
  if (route.kind === "chat") {
    return "#/";
  }
  if (route.kind === "add") {
    return "#/add";
  }
  if (route.kind === "provider") {
    return `#/p/${encodeURIComponent(route.providerId)}`;
  }
  return `#/p/${encodeURIComponent(route.providerId)}/m/${encodeURIComponent(route.modelId)}`;
}

export function go(route: Route): void {
  const next = toHash(route);
  const current = window.location.hash;
  const alreadyChat = route.kind === "chat" && (current === "" || current === "#" || current === "#/");
  if (current === next || alreadyChat) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  window.location.hash = next;
}

export function paneKind(route: Route): "chat" | "provider" | "model" | "add" {
  return route.kind;
}
