import { type AbsPath, type ProviderId, type SecretBytes } from "../domain/types.ts";

export type SecretStore = {
  readonly providers: { readonly [id: string]: SecretBytes };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseSecretBytes(raw: string): SecretBytes {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("OpenBot: secret is empty");
  }
  return trimmed as SecretBytes;
}

export function parseProviderId(raw: string): ProviderId {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(raw)) {
    throw new Error("OpenBot: provider id is not a slug");
  }
  return raw as ProviderId;
}

export function readSecretStore(raw: string): SecretStore {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !isRecord(parsed.providers)) {
    throw new Error("OpenBot: secrets file is not { providers }");
  }
  const providers: { [id: string]: SecretBytes } = {};
  for (const [id, value] of Object.entries(parsed.providers)) {
    if (typeof value !== "string") {
      throw new Error("OpenBot: secret values must be strings");
    }
    providers[id] = parseSecretBytes(value);
  }
  return { providers };
}

export function writeSecretStore(store: SecretStore): string {
  return `${JSON.stringify({ providers: store.providers }, null, 2)}\n`;
}

export function upsertSecret(store: SecretStore, providerId: ProviderId, secret: SecretBytes): SecretStore {
  return { providers: { ...store.providers, [providerId]: secret } };
}

export function secretFor(store: SecretStore, providerId: ProviderId): SecretBytes | undefined {
  return store.providers[providerId];
}

export type SecretsFs = {
  read(path: AbsPath): string | undefined;
  write(path: AbsPath, body: string, mode: number): void;
};

export function loadSecrets(fs: SecretsFs, path: AbsPath): SecretStore {
  const raw = fs.read(path);
  if (raw === undefined) {
    return { providers: {} };
  }
  return readSecretStore(raw);
}

export function saveSecrets(fs: SecretsFs, path: AbsPath, store: SecretStore): void {
  fs.write(path, writeSecretStore(store), 0o600);
}
