/** Canonical public URL for a live Cloudflare quick tunnel. */
export function publicTunnelUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}
