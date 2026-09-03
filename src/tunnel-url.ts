/**
 * Canonical public URL for a live Cloudflare quick tunnel.
 *
 * `parseQuickTunnelUrl` already returns a full `https://….trycloudflare.com`
 * address. Callers must not prefix `https://` again. This helper collapses
 * repeated schemes, trims whitespace, and adds `https://` only when the
 * input has no scheme. An `http://` URL stays http so the result is never
 * `https://http://…`.
 */
export function publicTunnelUrl(url: string): string {
  let rest = url.trim();
  let scheme = "https";
  for (;;) {
    const match = /^(https?):\/\//i.exec(rest);
    if (match === null) {
      break;
    }
    const peeled = match[1];
    const token = match[0];
    if (!peeled || token === undefined) {
      break;
    }
    scheme = peeled.toLowerCase();
    rest = rest.slice(token.length).trimStart();
  }
  return `${scheme}://${rest}`;
}
