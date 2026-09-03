import type { CredentialPort, OAuthAdapter, OAuthLoginResult } from '@aio-proxy/plugin-sdk';
import { OAuthPluginProviderSchema } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';
import { z } from 'zod';

import { parseRuntimeConfig } from '../../config';
import type { StoredAccount } from '../repository/index';
import { parsePluginSchema } from '../schema';
import { withAbort } from './deadline';
import {
  AccountCleanupPendingError,
  AccountOptionsValidationError,
  type OAuthCapabilityReference,
  OAuthLoginResultValidationError,
  ProviderAccountAlreadyExistsError,
  ProviderConfigInvalidError,
} from './errors';
import type { OAuthProviderPatch } from './login';

export type ConfigRecord = Record<string, unknown>;
export type PlainRecord = Record<string, unknown>;
export function providerRecord(current: ConfigRecord): Record<string, unknown> {
  const providers = current['providers'];
  if (providers === undefined) return {};
  if (isPlainObject(providers)) return providers;
  parseRuntimeConfig(current);
  throw new ProviderConfigInvalidError();
}
export function structuredEntry(value: unknown): PlainRecord | null {
  if (!isPlainObject(value) || value['kind'] !== 'oauth' || Object.hasOwn(value, 'vendor')) return null;
  return OAuthPluginProviderSchema.safeParse({ ...value, id: 'staged' }).success ? value : null;
}
export function capabilityOf(entry: PlainRecord): OAuthCapabilityReference {
  return { plugin: entry['plugin'] as string, capability: entry['capability'] as string };
}
export function sameCapability(left: OAuthCapabilityReference, right: OAuthCapabilityReference): boolean {
  return left.plugin === right.plugin && left.capability === right.capability;
}
export function accountMatches(account: StoredAccount, capability: OAuthCapabilityReference): boolean {
  return account.plugin === capability.plugin && account.capability === capability.capability;
}
export function validateStagedOAuthWrite(candidate: ConfigRecord): void {
  const providers = candidate['providers'];
  if (!isPlainObject(providers)) {
    parseRuntimeConfig(candidate);
    return;
  }
  const legacyProviders: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(providers)) {
    if (isPlainObject(value) && value['kind'] === 'oauth' && !Object.hasOwn(value, 'vendor')) {
      const parsed = OAuthPluginProviderSchema.safeParse({ ...value, id });
      // A hand-edited `models` on an oauth provider is validated as of this branch, so this rejection is
      // reachable from an ordinary re-login. Standalone issue paths read `["models", 0]` and never say
      // which provider — unactionable in a config with several — so re-throw them rooted at the entry.
      // `ZodRealError` is the constructor `safeParse` itself uses, and unlike a bare `new z.ZodError` it
      // produces a true `instanceof Error` with a stack — which the log sites that record
      // `error instanceof Error ? error.name : ...` need to report `ZodError` rather than `Error`/`object`.
      // It has to be a fresh error rather than a mutated `parsed.error`: `message` is stringified once at
      // construction, so re-rooting the paths afterwards would leave the rendered message unprefixed.
      if (!parsed.success) {
        throw new z.ZodRealError(
          parsed.error.issues.map((issue) => ({ ...issue, path: ['providers', id, ...issue.path] })),
        );
      }
    } else {
      legacyProviders[id] = value;
    }
  }
  parseRuntimeConfig({ ...candidate, providers: legacyProviders });
}
export async function validatedAccountOptions<Options, Credential>(
  adapter: OAuthAdapter<Options, Credential>,
  rendered: { readonly publicValues: unknown; readonly secrets: unknown },
  signal: AbortSignal,
) {
  const { publicValues, secrets } = rendered;
  if (!isPlainObject(publicValues) || !isPlainObject(secrets)) throw new AccountOptionsValidationError();
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
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new OAuthLoginResultValidationError();
  const { fingerprint, suggestedKey, accountLabel, expiresAt, credentials } = raw;
  if (
    typeof fingerprint !== 'string' ||
    fingerprint.trim().length === 0 ||
    typeof suggestedKey !== 'string' ||
    (accountLabel !== undefined && typeof accountLabel !== 'string') ||
    (expiresAt !== undefined &&
      (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || !Number.isInteger(expiresAt)))
  )
    throw new OAuthLoginResultValidationError();
  const parsed = await withAbort(signal, () => parsePluginSchema(adapter.credentials, credentials));
  if (!parsed.ok) throw new OAuthLoginResultValidationError();
  return {
    fingerprint: fingerprint.trim(),
    suggestedKey,
    ...(accountLabel === undefined ? {} : { accountLabel }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    credential: parsed.value,
  };
}
export function inMemoryCredentialPort<Credential>(
  adapter: OAuthAdapter<unknown, Credential>,
  initial: Credential,
  signal: AbortSignal,
  metadata: { accountLabel?: string; expiresAt?: number },
): { readonly port: CredentialPort<Credential>; readonly current: () => Credential } {
  let value = initial;
  let revision = 0;
  type RefreshResult = Awaited<ReturnType<CredentialPort<Credential>['refresh']>>;
  let refreshFlight: Promise<RefreshResult> | undefined;
  return {
    port: {
      async read() {
        return { value, revision };
      },
      refresh(expectedRevision, exchange) {
        if (refreshFlight !== undefined) return refreshFlight;
        const flight = (async (): Promise<RefreshResult> => {
          if (expectedRevision !== revision) return { status: 'superseded', snapshot: { value, revision } };
          const exchanged = await exchange({ value, revision }, signal);
          const parsed = await withAbort(signal, () => parsePluginSchema(adapter.credentials, exchanged.value));
          if (!parsed.ok) throw new OAuthLoginResultValidationError();
          if (exchanged.metadata?.accountLabel !== undefined) metadata.accountLabel = exchanged.metadata.accountLabel;
          if (exchanged.metadata?.expiresAt !== undefined) {
            if (!Number.isFinite(exchanged.metadata.expiresAt) || !Number.isInteger(exchanged.metadata.expiresAt)) {
              throw new OAuthLoginResultValidationError();
            }
            metadata.expiresAt = exchanged.metadata.expiresAt;
          }
          value = parsed.value;
          revision += 1;
          return { status: 'updated', snapshot: { value, revision } };
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
  patch?: OAuthProviderPatch,
): PlainRecord {
  // Retention is per-field: a patch that omits a field keeps the stored value, because a re-login or a
  // partial edit surface must not delete config the user authored elsewhere. `weight` is the deliberate
  // exception — `{ weight: undefined }` is `{}` after JSON, so an omitted key is the only "absent" signal
  // a caller has, and retaining it would make a cleared weight unreachable over the wire. `name` gets the
  // same treatment via a blank-after-trim value, its own surviving clear signal (see the entry spread
  // below).
  //
  // `replaceProvider` in server's dashboard-routes/provider-mutation answers the same question for the
  // config-provider PUT path, with a much shorter field list, and the two are deliberately not unified.
  // Its input is a full authored replacement body, so omission there means "delete" and only the fields
  // the editor cannot round-trip are retained; this input is a partial patch, so omission means "keep"
  // and the exceptions are enumerated instead. Same rule, opposite defaults, because the contracts
  // differ — a shared helper would have to hide that.
  const enabled = patch?.enabled ?? existing?.['enabled'] ?? true;
  const priority = patch === undefined ? existing?.['priority'] : patch.priority;
  const weight = patch === undefined ? existing?.['weight'] : patch.weight;
  const name = patch?.name === undefined ? existing?.['name'] : patch.name;
  const alias = patch?.alias ?? existing?.['alias'];
  const excludedModels =
    patch !== undefined && Object.hasOwn(patch, 'excludedModels') ? patch.excludedModels : existing?.['excludedModels'];
  const proxy = patch?.proxy === undefined ? existing?.['proxy'] : patch.proxy;
  const transforms = patch?.transforms === undefined ? existing?.['transforms'] : patch.transforms;
  return {
    kind: 'oauth',
    plugin,
    capability,
    ...(Object.keys(publicOptions).length === 0 ? {} : { options: publicOptions }),
    enabled,
    ...(priority === undefined ? {} : { priority }),
    ...(weight === undefined ? {} : { weight }),
    ...(name === undefined || (typeof name === 'string' && name.trim() === '') ? {} : { name }),
    ...(alias === undefined ? {} : { alias }),
    ...(excludedModels === undefined ? {} : { excludedModels }),
    ...(proxy === undefined || proxy === null ? {} : { proxy }),
    ...(transforms === undefined ? {} : { transforms }),
  };
}
export function duplicateOrCleanup(account: StoredAccount, providers: Record<string, unknown>) {
  const entry = structuredEntry(providers[account.providerId]);
  return entry !== null && accountMatches(account, capabilityOf(entry))
    ? new ProviderAccountAlreadyExistsError(account.providerId)
    : new AccountCleanupPendingError(account.providerId);
}
