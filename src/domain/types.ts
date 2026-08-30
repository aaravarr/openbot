/**
 * OpenBot domain types. The product is a box supervisor.
 * Official chat is wrap-gone. Custom chat is marked wrap plus loopback hop.
 * Secrets never appear on Binding. The generic hop cannot drop SendToUser.
 */

export const OPENBOT_MARKER = "/* openbot-stock-wrap */" as const;
export const OPENGROK_MARKER = "/* opengrok-stock-wrap */" as const;
export const HOST_MAIN = "/home/box/sand-host/host-main.cjs" as const;
export const SAND_DATA = "/home/box/sand-data" as const;
export const DEFAULT_SECRETS_PATH = "/home/box/sand-data/secrets.json" as const;
export const HOP_PORT = 18790 as const;
export const UI_PORT = 18791 as const;
export const LOOPBACK = "127.0.0.1" as const;
export const HIGH_AGENT_MAX_TOKENS = 65536 as const;
export const KNOWN_HOST_BACKUP = "/home/box/sand-data/host-main.cjs.pre-openbot" as const;

export type Brand<T, B extends string> = T & { readonly __brand: B };

export type AbsPath = Brand<string, "AbsPath">;
export type AgentId = Brand<string, "AgentId">;
export type ProviderId = Brand<string, "ProviderId">;
export type ModelId = Brand<string, "ModelId">;
export type ModelSlug = Brand<string, "ModelSlug">;
export type HopBaseUrl = Brand<string, "HopBaseUrl">;
export type UpstreamOrigin = Brand<string, "UpstreamOrigin">;
export type OwnedPid = Brand<number, "OwnedPid">;
export type ForeignPid = Brand<number, "ForeignPid">;
export type SecretBytes = Brand<string, "SecretBytes">;

export type LoopbackHop = { readonly host: typeof LOOPBACK; readonly port: typeof HOP_PORT };

export const LOOPBACK_HOP: LoopbackHop = { host: LOOPBACK, port: HOP_PORT };

export type ConversationKey =
  | { readonly kind: "wildcard" }
  | { readonly kind: "agent"; readonly id: AgentId };

export type RequestedModelOverride = never;
export type SendToUserDrop = never;
export type ForceFinishStop = never;
export type HopDefaultMaxTokens8192 = never;
export type GlmInstallerFastTrue = never;
export type SigKill = never;
export type RawNodeHostStart = never;
export type MacAsarPatch = never;
export type ApplyBoxPatchOnStock = never;
export type SecondHopMapsFile = never;
export type IdentityOfficialWrap = never;

type SecretKeys = "apiKey" | "Authorization" | "API_SERVER_KEY" | "secret" | "key" | "password";

export type ProviderParameter = { readonly id: string; readonly value: string };

export type Provider = {
  readonly id: ProviderId;
  readonly name: string;
  readonly origin: UpstreamOrigin;
  readonly maxTokensDefault: number;
  readonly mapFile: "provider-maps.cjs";
};

export type Model = {
  readonly id: ModelId;
  readonly providerId: ProviderId;
  readonly slug: ModelSlug;
  readonly parameters: readonly ProviderParameter[];
};

/** Conversation to model only. Hop URL is derived. Keys are unrepresentable. */
export type Binding = {
  readonly conversation: ConversationKey;
  readonly modelId: ModelId;
} & { readonly [K in SecretKeys]?: never };

export type Catalog = {
  readonly providers: readonly Provider[];
  readonly models: readonly Model[];
  readonly bindings: readonly Binding[];
};

export type OfficialBox = {
  readonly kind: "official";
  readonly wrap: { readonly kind: "stock" };
  readonly hopListen: { readonly kind: "stop-owned" };
  readonly uiListen: {
    readonly kind: "loopback";
    readonly host: typeof LOOPBACK;
    readonly port: typeof UI_PORT;
  };
  readonly secretsPath: AbsPath;
  readonly hop?: never;
  readonly catalog?: never;
  readonly upstream?: never;
};

export type CustomBox = {
  readonly kind: "custom";
  readonly wrap: { readonly kind: "marked"; readonly marker: typeof OPENBOT_MARKER };
  readonly hopListen: {
    readonly kind: "adopt-or-start";
    readonly host: typeof LOOPBACK;
    readonly port: typeof HOP_PORT;
  };
  readonly uiListen: {
    readonly kind: "loopback";
    readonly host: typeof LOOPBACK;
    readonly port: typeof UI_PORT;
  };
  readonly secretsPath: AbsPath;
  readonly catalog: Catalog;
  readonly hop: LoopbackHop;
};

export type DesiredState = OfficialBox | CustomBox;

export type Alignment =
  | { readonly kind: "ok"; readonly desired: DesiredState["kind"]; readonly wrap: WrapObserved["kind"] }
  | {
      readonly kind: "needs-reinstall";
      readonly desired: "custom";
      readonly wrap: "stock-unmarked";
    };

export type WrapObserved =
  | { readonly kind: "stock-unmarked" }
  | { readonly kind: "openbot-marked"; readonly marker: typeof OPENBOT_MARKER }
  | { readonly kind: "foreign-opengrok" }
  | { readonly kind: "private-lane" }
  | { readonly kind: "gap"; readonly present: HopSymbol; readonly missing: HopSymbol }
  | { readonly kind: "ambiguous-factory"; readonly functionDefs: number; readonly propertyDefs: number };

export type HopSymbol = "createOpenAiHopSession" | "resolvedOpenaiBaseUrl";

export type PortObserved =
  | { readonly kind: "ours"; readonly pid: OwnedPid; readonly host: typeof LOOPBACK; readonly port: number }
  | { readonly kind: "foreign"; readonly pid: ForeignPid; readonly host: string; readonly port: number }
  | { readonly kind: "absent" };

export type HostObserved =
  | { readonly kind: "running-owned"; readonly pid: OwnedPid }
  | { readonly kind: "running-unowned"; readonly pid: ForeignPid }
  | { readonly kind: "needs-term"; readonly pid: OwnedPid; readonly bounceHint: string }
  | { readonly kind: "absent" };

export type Snapshot = {
  readonly wrap: WrapObserved;
  readonly hopListen: PortObserved;
  readonly uiListen: PortObserved;
  readonly host: HostObserved;
  readonly alignment: Alignment;
};

export type GenericHop = {
  readonly kind: "generic";
  readonly unwrapJsonSchema: true;
  readonly toolCallMapping: "host-ai-sdk";
  readonly finishReasonMapping: "tool-calls";
  readonly honorModelStop: true;
};

export type NamedOptInStrategy =
  | { readonly name: "synthesize-send-to-user" }
  | { readonly name: "recover-content-tool-calls" };

export type HostCensus =
  | {
      readonly kind: "stock";
      readonly providerFactoryDef: "function createProtoSessionProvider(";
      readonly providerFactoryDefCount: 1;
      readonly providerFactoryAsync: false;
      readonly createProtoSessionParen: 0;
      readonly createOpenAiHopSession: 0;
      readonly resolvedOpenaiBaseUrl: 0;
      readonly alreadyMarked: false;
    }
  | { readonly kind: "already-openbot"; readonly marker: typeof OPENBOT_MARKER }
  | { readonly kind: "foreign-opengrok"; readonly marker: typeof OPENGROK_MARKER }
  | {
      readonly kind: "private-lane";
      readonly createOpenAiHopSession: number;
      readonly resolvedOpenaiBaseUrl: number;
    }
  | { readonly kind: "gap"; readonly present: HopSymbol; readonly missing: HopSymbol }
  | { readonly kind: "ambiguous-factory"; readonly functionDefs: number; readonly propertyDefs: number };

export function hopBaseUrl(hop: LoopbackHop): HopBaseUrl {
  return `http://${hop.host}:${String(hop.port)}/v1` as HopBaseUrl;
}

export function align(desired: DesiredState, wrap: WrapObserved): Alignment {
  if (desired.kind === "custom" && wrap.kind === "stock-unmarked") {
    return { kind: "needs-reinstall", desired: "custom", wrap: "stock-unmarked" };
  }
  return { kind: "ok", desired: desired.kind, wrap: wrap.kind };
}

type _OfficialCannotHop = OfficialBox extends { hop: LoopbackHop } ? never : true;
const officialCannotHop: _OfficialCannotHop = true;
void officialCannotHop;

type _BindingRejectsKey = Binding extends { apiKey: string } ? never : true;
const bindingRejectsKey: _BindingRejectsKey = true;
void bindingRejectsKey;

type _GenericHopHasNoDrop = "sendToUserDrop" extends keyof GenericHop ? never : true;
const genericHopHasNoDrop: _GenericHopHasNoDrop = true;
void genericHopHasNoDrop;

type _NoIdentityOfficial = IdentityOfficialWrap extends never ? true : never;
const noIdentityOfficial: _NoIdentityOfficial = true;
void noIdentityOfficial;
