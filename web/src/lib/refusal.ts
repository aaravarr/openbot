import type { RefusalError } from "../api/types";

/**
 * Human remedy copy for the structured reconcile refusals (FR-7).
 * Every failure maps to a named condition with a next step.
 */
export function refusalRemedy(refusal: RefusalError): string {
  switch (refusal.kind) {
    case "host-missing":
      return "host-main.cjs not found — is Grok Bot installed on this machine?";
    case "foreign-hop":
      return "Another process owns the hop on port 9280. Stop it, then retry.";
    case "foreign-ui":
      return "Another process owns port 9280. Stop it, then retry.";
    case "foreign-opengrok":
      return "A foreign opengrok wrap is present; remove it before OpenBot can manage the host.";
    case "census-refused":
      return `Host file layout not recognized: ${refusal.reason}.`;
    case "syntax-check-failed":
      return "Wrapped host failed node --check. See diagnostics for stderr.";
    case "listen-failed":
      return `Port ${refusal.port} could not be bound.`;
    default:
      return "The change was refused. See diagnostics.";
  }
}

export function refusalKindLabel(refusal: RefusalError): string {
  return refusal.kind;
}

/** Extra diagnostic detail (stderr, path, reason) for the "View diagnostics" pane. */
export function refusalDetail(refusal: RefusalError): string | undefined {
  switch (refusal.kind) {
    case "syntax-check-failed":
      return refusal.stderr;
    case "census-refused":
      return refusal.reason;
    case "host-missing":
      return refusal.path;
    case "listen-failed":
      return `port ${refusal.port}`;
    default:
      return undefined;
  }
}
