import { OPENBOT_MARKER, OPENGROK_MARKER, type HostCensus } from "../domain/types.ts";
import { censusHost, hasForeignOpengrokWrap } from "./census.ts";

export type WrapProof =
  | { readonly kind: "already-marked"; readonly source: string }
  | { readonly kind: "wrapped"; readonly source: string }
  | { readonly kind: "refused"; readonly census: HostCensus; readonly reason: string };

const WRAPPER = `function createProtoSessionProvider() {
  return __openbotRuntime.attachSession(createProtoSessionProvider_stock, arguments);
}
`;

const HEADER_RE =
  /^\/\* openbot-stock-wrap \*\/\n(?:\/\* openbot-payload [0-9a-f]{8,64} \*\/\n)?var __openbotRuntime = require\((?:'[^']+'|"[^"]+")\);\nfunction createProtoSessionProvider\(\) \{\n  return __openbotRuntime\.(?:wrapSession|attachSession)\(createProtoSessionProvider_stock, arguments\);\n\}\n/;

const OPENGROK_HEADER_RE =
  /^\/\* opengrok-stock-wrap \*\/\nvar __opengrokRuntime = require\((?:'[^']+'|"[^"]+")\);\n(?:async )?function createProtoSessionProvider\(\) \{\n  return __opengrokRuntime\.wrapSession\(createProtoSessionProvider_stock, arguments\);\n\}\n/;

const LEFTOVER_MARKER_RE = /^\s*\/\* openbot-stock-wrap \*\/\s*\n/;

/** A wrap header without a stamp is pre-stamp code: always treated as stale. */
export function extractPayloadFingerprint(source: string): string | undefined {
  const match = source.match(/^\/\* openbot-payload ([0-9a-f]{8,64}) \*\/$/m);
  return match?.[1];
}

function stampLine(fingerprint: string): string | undefined {
  if (!/^[0-9a-f]{8,64}$/.test(fingerprint)) {
    return undefined;
  }
  return `/* openbot-payload ${fingerprint} */\n`;
}

/**
 * Ensure the wrap header carries the current payload fingerprint. Returns
 * the source unchanged when the stamp already matches; inserts or replaces
 * the stamp line otherwise. Never touches unmarked sources.
 */
export function refreshPayloadStamp(source: string, fingerprint: string): { source: string; changed: boolean } {
  if (!source.includes(OPENBOT_MARKER)) {
    return { source, changed: false };
  }
  if (extractPayloadFingerprint(source) === fingerprint) {
    return { source, changed: false };
  }
  const line = stampLine(fingerprint);
  if (line === undefined) {
    return { source, changed: false };
  }
  if (/^\/\* openbot-payload [0-9a-f]{8,64} \*\/\n/m.test(source)) {
    return { source: source.replace(/^\/\* openbot-payload [0-9a-f]{8,64} \*\/\n/m, line), changed: true };
  }
  const markerAt = source.indexOf(OPENBOT_MARKER);
  const eol = source.indexOf("\n", markerAt);
  if (eol < 0) {
    return { source: `${source}\n${line}`, changed: true };
  }
  return { source: `${source.slice(0, eol + 1)}${line}${source.slice(eol + 1)}`, changed: true };
}

export function wrapHostSource(input: {
  source: string;
  runtimePath: string;
  payloadFingerprint?: string | undefined;
}): WrapProof {
  const { source, runtimePath } = input;
  if (source.includes(OPENBOT_MARKER)) {
    return { kind: "already-marked", source };
  }
  if (hasForeignOpengrokWrap(source)) {
    return {
      kind: "refused",
      census: censusHost(source),
      reason: "host already has an opengrok wrap; restore the vendor file first",
    };
  }
  const census = censusHost(source);
  if (census.kind !== "stock") {
    return { kind: "refused", census, reason: `wrap requires a stock unique factory, census is ${census.kind}` };
  }
  const needle = "function createProtoSessionProvider(";
  const at = source.indexOf(needle);
  if (at < 0) {
    return { kind: "refused", census, reason: "stock census passed but the factory definition is missing" };
  }
  const renamed =
    source.slice(0, at) + "function createProtoSessionProvider_stock(" + source.slice(at + needle.length);
  const stamp = typeof input.payloadFingerprint === "string" ? (stampLine(input.payloadFingerprint) ?? "") : "";
  const header =
    `${OPENBOT_MARKER}\n` + stamp + `var __openbotRuntime = require(${JSON.stringify(runtimePath)});\n` + WRAPPER;
  return { kind: "wrapped", source: header + renamed };
}

/** Run the wrap transform on a copy. This is the dry-run proof. Census is not proof. */
export function proveWrap(input: { source: string; runtimePath: string }): WrapProof {
  return wrapHostSource(input);
}

export function stripWrap(source: string): string {
  if (!source.includes(OPENBOT_MARKER)) {
    return source;
  }
  const stripped = source.replace(HEADER_RE, "");
  const renamed = stripped.replaceAll("createProtoSessionProvider_stock", "createProtoSessionProvider");
  if (!renamed.includes(OPENBOT_MARKER)) {
    return renamed;
  }
  const leftover = renamed.replace(LEFTOVER_MARKER_RE, "");
  if (leftover !== renamed && censusHost(leftover).kind === "stock") {
    return leftover;
  }
  return renamed;
}

export function stripOpengrokWrap(source: string): string {
  if (!source.includes(OPENGROK_MARKER)) {
    return source;
  }
  const stripped = source.replace(OPENGROK_HEADER_RE, "");
  return stripped.replaceAll("createProtoSessionProvider_stock", "createProtoSessionProvider");
}

export function peelOpengrokToStock(source: string): { kind: "stock"; source: string } | { kind: "still-foreign" } {
  if (!hasForeignOpengrokWrap(source)) {
    return censusHost(source).kind === "stock" ? { kind: "stock", source } : { kind: "still-foreign" };
  }
  const peeled = stripOpengrokWrap(source);
  if (censusHost(peeled).kind === "stock") {
    return { kind: "stock", source: peeled };
  }
  return { kind: "still-foreign" };
}
