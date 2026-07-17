import type { CredentialPort, OAuthAdapter, OAuthLoginResult } from "@aio-proxy/plugin-sdk";
import { ConfigSchema, OAuthPluginProviderSchema } from "@aio-proxy/types";
import type { StoredAccount } from "../repository";
import { parsePluginSchema } from "../schema";
import { withAbort } from "./deadline";
import {
  AccountCleanupPendingError,
  AccountOptionsValidationError,
  type OAuthCapabilityReference,
  OAuthLoginResultValidationError,
  ProviderAccountAlreadyExistsError,
  ProviderConfigInvalidError,
} from "./errors";

export type ConfigRecord = Record<string, unknown>;
export type PlainRecord = Record<string, unknown>;
export function isRecord(value: unknown): value is PlainRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function providerRecord(current: ConfigRecord): Record<string, unknown> {
  const providers = current["providers"];
  if (providers === undefined) return {};
  if (isRecord(providers)) return providers;
  ConfigSchema.parse(current);
  throw new ProviderConfigInvalidError();
}
export function structuredEntry(value: unknown): PlainRecord | null {
  if (!isRecord(value) || value["kind"] !== "oauth" || Object.hasOwn(value, "vendor")) return null;
  return OAuthPluginProviderSchema.safeParse({ ...value, id: "staged" }).success ? value : null;
}
export function capabilityOf(entry: PlainRecord): OAuthCapabilityReference {
  return { plugin: entry["plugin"] as string, capability: entry["capability"] as string };
}
export function sameCapability(left: OAuthCapabilityReference, right: OAuthCapabilityReference): boolean {
  return left.plugin === right.plugin && left.capability === right.capability;
}
export function accountMatches(account: StoredAccount, capability: OAuthCapabilityReference): boolean {
  return account.plugin === capability.plugin && account.capability === capability.capability;
}
export function validateStagedOAuthWrite(candidate: ConfigRecord): void {
  const providers = candidate["providers"];
  if (!isRecord(providers)) {
    ConfigSchema.parse(candidate);
    return;
  }
  const legacyProviders: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(providers)) {
    if (isRecord(value) && value["kind"] === "oauth" && !Object.hasOwn(value, "vendor")) {
      OAuthPluginProviderSchema.parse({ ...value, id });
    } else {
      legacyProviders[id] = value;
    }
  }
  ConfigSchema.parse({ ...candidate, providers: legacyProviders });
}
export function stringLeaves(value: unknown, seen = new Set<object>()): string[] {
  if (typeof value === "string") return value.length === 0 ? [] : [value];
  if (typeof value !== "object" || value === null || seen.has(value)) return [];
  seen.add(value);
  try {
    return Object.values(value).flatMap((item) => stringLeaves(item, seen));
  } catch {
    return [];
  } finally {
    seen.delete(value);
  }
}
export async function validatedAccountOptions<Options, Credential>(
  adapter: OAuthAdapter<Options, Credential>,
  rendered: { readonly publicValues: unknown; readonly secrets: unknown },
  signal: AbortSignal,
) {
  const { publicValues, secrets } = rendered;
  if (!isRecord(publicValues) || !isRecord(secrets)) throw new AccountOptionsValidationError();
  const parsed = await withAbort(signal, () =>
    parsePluginSchema(adapter.account.options.schema, { ...publicValues, ...secrets }),
  );
  if (!parsed.ok) throw new AccountOptionsValidationError();
  return parsed;
}
export async function validatedLoginResult<Credential>(
  adapter: OAuthAdapter<unknown, Credential>,
  raw: OAuthLoginResult<Credential>,
  signal: AbortSignal,
) {
  if (!isRecord(raw)) throw new OAuthLoginResultValidationError();
  const { fingerprint, suggestedKey, label, expiresAt, credentials } = raw;
  if (
    typeof fingerprint !== "string" ||
    fingerprint.trim().length === 0 ||
    typeof suggestedKey !== "string" ||
    (label !== undefined && typeof label !== "string") ||
    (expiresAt !== undefined &&
      (typeof expiresAt !== "number" || !Number.isFinite(expiresAt) || !Number.isInteger(expiresAt)))
  )
    throw new OAuthLoginResultValidationError();
  const parsed = await withAbort(signal, () => parsePluginSchema(adapter.credentials, credentials));
  if (!parsed.ok) throw new OAuthLoginResultValidationError();
  return {
    fingerprint: fingerprint.trim(),
    suggestedKey,
    ...(label === undefined ? {} : { label }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    credential: parsed.value,
  };
}
export function inMemoryCredentialPort<Credential>(
  adapter: OAuthAdapter<unknown, Credential>,
  initial: Credential,
  signal: AbortSignal,
  metadata: { label?: string; expiresAt?: number },
): { readonly port: CredentialPort<Credential>; readonly current: () => Credential } {
  let value = initial;
  let revision = 0;
  type RefreshResult = Awaited<ReturnType<CredentialPort<Credential>["refresh"]>>;
  let refreshFlight: Promise<RefreshResult> | undefined;
  return {
    port: {
      async read() {
        return { value, revision };
      },
      refresh(expectedRevision, exchange) {
        if (refreshFlight !== undefined) return refreshFlight;
        const flight = (async (): Promise<RefreshResult> => {
          if (expectedRevision !== revision) return { status: "superseded", snapshot: { value, revision } };
          const exchanged = await exchange({ value, revision }, signal);
          const parsed = await withAbort(signal, () => parsePluginSchema(adapter.credentials, exchanged.value));
          if (!parsed.ok) throw new OAuthLoginResultValidationError();
          if (exchanged.metadata?.label !== undefined) metadata.label = exchanged.metadata.label;
          if (exchanged.metadata?.expiresAt !== undefined) {
            if (!Number.isFinite(exchanged.metadata.expiresAt) || !Number.isInteger(exchanged.metadata.expiresAt)) {
              throw new OAuthLoginResultValidationError();
            }
            metadata.expiresAt = exchanged.metadata.expiresAt;
          }
          value = parsed.value;
          revision += 1;
          return { status: "updated", snapshot: { value, revision } };
        })();
        refreshFlight = flight;
        const cleanup = () => {
          if (refreshFlight === flight) refreshFlight = undefined;
        };
        void flight.then(cleanup, cleanup);
        return flight;
      },
    },
    current: () => value,
  };
}
export function providerEntry(
  plugin: string,
  capability: string,
  publicOptions: Record<string, unknown>,
  existing?: PlainRecord,
): PlainRecord {
  return {
    kind: "oauth",
    plugin,
    capability,
    ...(Object.keys(publicOptions).length === 0 ? {} : { options: publicOptions }),
    enabled: existing?.["enabled"] ?? true,
    ...(existing?.["weight"] === undefined ? {} : { weight: existing["weight"] }),
    ...(existing?.["name"] === undefined ? {} : { name: existing["name"] }),
    ...(existing?.["alias"] === undefined ? {} : { alias: existing["alias"] }),
  };
}
export function duplicateOrCleanup(account: StoredAccount, providers: Record<string, unknown>) {
  const entry = structuredEntry(providers[account.providerId]);
  return entry !== null && accountMatches(account, capabilityOf(entry))
    ? new ProviderAccountAlreadyExistsError(account.providerId)
    : new AccountCleanupPendingError(account.providerId);
}
