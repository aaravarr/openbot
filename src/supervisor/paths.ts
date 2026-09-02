import {
  DEFAULT_SECRETS_PATH,
  HOST_MAIN,
  KNOWN_HOST_BACKUP,
  SAND_DATA,
  type AbsPath,
} from "../domain/types.ts";

export type BoxPaths = {
  readonly hostMain: AbsPath;
  readonly sandData: AbsPath;
  readonly secrets: AbsPath;
  readonly knownBackup: AbsPath;
  readonly runtime: AbsPath;
  readonly hopServer: AbsPath;
  readonly maps: AbsPath;
  readonly plan: AbsPath;
  readonly mode: AbsPath;
  readonly hopPid: AbsPath;
  readonly uiPid: AbsPath;
  readonly hopLog: AbsPath;
  readonly uiLog: AbsPath;
  readonly uiServer: AbsPath;
  readonly repoRoot: AbsPath;
  readonly expose: AbsPath;
  readonly logsSettings: AbsPath;
  readonly modelCatalog: AbsPath;
  readonly requestLog: AbsPath;
  readonly requestBodiesDir: AbsPath;
  readonly tunnelPid: AbsPath;
  readonly tunnelLog: AbsPath;
  readonly tunnelCache: AbsPath;
  readonly tunnelBin: AbsPath;
};

export function parseAbsPath(raw: string): AbsPath {
  if (!raw.startsWith("/") || raw.includes("\0") || raw.includes("\n")) {
    throw new Error("OpenBot: path must be an absolute Unix path");
  }
  return raw as AbsPath;
}

export function joinAbs(root: AbsPath, ...parts: string[]): AbsPath {
  const trimmed = parts.map((part) => part.replace(/^\/+/u, "")).join("/");
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  return parseAbsPath(`${base}/${trimmed}`);
}

export function boxPathsFrom(input: {
  sandData?: string | undefined;
  hostMain?: string | undefined;
  repoRoot: string;
}): BoxPaths {
  const sandData = parseAbsPath(input.sandData ?? SAND_DATA);
  const hostMain = parseAbsPath(input.hostMain ?? HOST_MAIN);
  const repoRoot = parseAbsPath(input.repoRoot);
  return {
    hostMain,
    sandData,
    secrets: sandData === SAND_DATA ? parseAbsPath(DEFAULT_SECRETS_PATH) : joinAbs(sandData, "secrets.json"),
    knownBackup:
      sandData === SAND_DATA ? parseAbsPath(KNOWN_HOST_BACKUP) : joinAbs(sandData, "host-main.cjs.pre-openbot"),
    runtime: joinAbs(repoRoot, "payload/runtime.cjs"),
    hopServer: joinAbs(repoRoot, "payload/hop-server.cjs"),
    maps: joinAbs(repoRoot, "payload/provider-maps.cjs"),
    plan: joinAbs(sandData, "openbot-plan.json"),
    mode: joinAbs(sandData, "openbot-mode"),
    hopPid: joinAbs(sandData, "openbot-hop.pid"),
    uiPid: joinAbs(sandData, "openbot-ui.pid"),
    hopLog: joinAbs(sandData, "openbot-hop.log"),
    uiLog: joinAbs(sandData, "openbot-ui.log"),
    uiServer: joinAbs(repoRoot, "src/ui/server.ts"),
    repoRoot,
    expose: joinAbs(sandData, "openbot-expose"),
    logsSettings: joinAbs(sandData, "openbot-logs.json"),
    modelCatalog: joinAbs(sandData, "openbot-model-catalog.json"),
    requestLog: joinAbs(sandData, "openbot-requests.jsonl"),
    requestBodiesDir: joinAbs(sandData, "openbot-request-bodies"),
    tunnelPid: joinAbs(sandData, "openbot-tunnel.pid"),
    tunnelLog: joinAbs(sandData, "openbot-tunnel.log"),
    tunnelCache: joinAbs(sandData, "openbot-tunnel.json"),
    tunnelBin: joinAbs(sandData, "bin/cloudflared"),
  };
}

export function defaultBoxPaths(repoRoot: string): BoxPaths {
  return boxPathsFrom({ repoRoot });
}
