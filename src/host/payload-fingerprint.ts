import { createHash } from "node:crypto";

/**
 * Payload version fingerprint.
 *
 * The host file's wrap header is byte-stable across payload deploys (the
 * header only embeds the runtime path), so reconcile used to see "no wrap
 * change" after a payload update and never bounced the stale host process.
 * The fingerprint below hashes every payload file that executes inside the
 * host; reconcile stamps it into the wrap header and treats a mismatch as a
 * wrap change, which terms the stale host (its own supervisor relaunches it
 * on the new payload).
 */

/** Payload files whose bytes execute inside the host process. */
export const PAYLOAD_FINGERPRINT_FILES = [
  "hop-handler.cjs",
  "hop-server.cjs",
  "image-read.cjs",
  "openai-messages.cjs",
  "openai-stream.cjs",
  "provider-maps.cjs",
  "request-log.cjs",
  "runtime.cjs",
  "version.cjs",
] as const;

/** Install-stamped commit marker; present in box installs, absent in checkouts. */
export const PAYLOAD_VERSION_FILE = "version.json" as const;

export function payloadFingerprint(input: {
  readonly payloadDir: string;
  readonly read: (path: string) => string | undefined;
}): string {
  const hash = createHash("sha256");
  const names = [...PAYLOAD_FINGERPRINT_FILES, PAYLOAD_VERSION_FILE];
  for (const name of names) {
    hash.update(name, "utf8");
    hash.update("\0", "utf8");
    // A missing file contributes only its name: adding or removing a payload
    // file still moves the fingerprint.
    hash.update(input.read(`${input.payloadDir}/${name}`) ?? "", "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex").slice(0, 16);
}
