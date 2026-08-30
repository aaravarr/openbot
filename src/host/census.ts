import { OPENBOT_MARKER, type HostCensus } from "../domain/types.ts";

export const OPENGROK_MARKER = "/* opengrok-stock-wrap */" as const;

const FACTORY_DEF = "function createProtoSessionProvider(";
const ASYNC_FACTORY_DEF = "async function createProtoSessionProvider(";
const TRAP_DEF = "function createProtoSession(";
const HOP_SESSION = "createOpenAiHopSession";
const HOP_URL = "resolvedOpenaiBaseUrl";
const FUNCTION_DEF_RE = /(?:async\s+)?function\s+createProtoSessionProvider\s*\(/g;
const PROPERTY_DEF_RE = /createProtoSessionProvider\s*:\s*(?:async\s+)?function\s*\(/g;

export function countLiteral(source: string, needle: string): number {
  let n = 0;
  let from = 0;
  while (from < source.length) {
    const at = source.indexOf(needle, from);
    if (at < 0) {
      return n;
    }
    n += 1;
    from = at + needle.length;
  }
  return n;
}

function countMatches(source: string, re: RegExp): number {
  const copy = new RegExp(re.source, re.flags);
  return [...source.matchAll(copy)].length;
}

export function censusHost(source: string): HostCensus {
  if (source.includes(OPENBOT_MARKER)) {
    return { kind: "already-openbot", marker: OPENBOT_MARKER };
  }

  const hopSession = countLiteral(source, HOP_SESSION);
  const hopUrl = countLiteral(source, HOP_URL);
  if (hopSession > 0 && hopUrl > 0) {
    return {
      kind: "private-lane",
      createOpenAiHopSession: hopSession,
      resolvedOpenaiBaseUrl: hopUrl,
    };
  }
  if (hopSession > 0) {
    return { kind: "gap", present: "createOpenAiHopSession", missing: "resolvedOpenaiBaseUrl" };
  }
  if (hopUrl > 0) {
    return { kind: "gap", present: "resolvedOpenaiBaseUrl", missing: "createOpenAiHopSession" };
  }

  const functionDefs = countMatches(source, FUNCTION_DEF_RE);
  const propertyDefs = countMatches(source, PROPERTY_DEF_RE);
  if (functionDefs !== 1 || propertyDefs !== 0) {
    return { kind: "ambiguous-factory", functionDefs, propertyDefs };
  }

  const asyncFactory = source.includes(ASYNC_FACTORY_DEF);
  const providerFactoryDefCount = countLiteral(source, FACTORY_DEF);
  const trap = countLiteral(source, TRAP_DEF);

  if (asyncFactory || providerFactoryDefCount !== 1 || trap !== 0) {
    return { kind: "ambiguous-factory", functionDefs, propertyDefs };
  }

  return {
    kind: "stock",
    providerFactoryDef: FACTORY_DEF,
    providerFactoryDefCount: 1,
    providerFactoryAsync: false,
    createProtoSessionParen: 0,
    createOpenAiHopSession: 0,
    resolvedOpenaiBaseUrl: 0,
    alreadyMarked: false,
  };
}

export function hasForeignOpengrokWrap(source: string): boolean {
  return source.includes(OPENGROK_MARKER);
}
