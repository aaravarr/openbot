import { OPENBOT_MARKER, type HostCensus } from "../domain/types.ts";
import { censusHost, hasForeignOpengrokWrap } from "./census.ts";

export type WrapProof =
  | { readonly kind: "already-marked"; readonly source: string }
  | { readonly kind: "wrapped"; readonly source: string }
  | { readonly kind: "refused"; readonly census: HostCensus; readonly reason: string };

const WRAPPER = `function createProtoSessionProvider() {
  return __openbotRuntime.wrapSession(createProtoSessionProvider_stock, arguments);
}
`;

const HEADER_RE =
  /^\/\* openbot-stock-wrap \*\/\nvar __openbotRuntime = require\((?:'[^']+'|"[^"]+")\);\nfunction createProtoSessionProvider\(\) \{\n  return __openbotRuntime\.wrapSession\(createProtoSessionProvider_stock, arguments\);\n\}\n/;

export function wrapHostSource(input: { source: string; runtimePath: string }): WrapProof {
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
  const header =
    `${OPENBOT_MARKER}\n` + `var __openbotRuntime = require(${JSON.stringify(runtimePath)});\n` + WRAPPER;
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
  return stripped.replaceAll("createProtoSessionProvider_stock", "createProtoSessionProvider");
}
