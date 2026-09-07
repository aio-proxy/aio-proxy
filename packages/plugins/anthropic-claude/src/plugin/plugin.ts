import {
  type ConfigSpec,
  definePlugin,
  type LocalizedText,
  type OAuthAdapter,
  type PluginDescriptor,
  type RuntimeFetch,
  zod,
} from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { CLAUDE_CATALOG_TTL_MS, discoverClaudeModels, initialClaudeCatalogFallback } from '../catalog';
import {
  type ClaudeOAuthDependencies,
  claudeLoginResult,
  loginClaude,
  normalizeClaudeEmail,
  refreshClaudeCredential,
  resolveClaudeIdentity,
} from '../oauth';
import { createClaudeRuntime } from '../runtime/index';
import { credentialSchema, type ClaudeCredential } from '../schema';

const cpaClaudeSchema = zod
  .object({
    type: zod.literal('claude'),
    access_token: zod.string().trim().min(1),
    refresh_token: zod.string().trim().min(1),
    expired: zod.unknown().optional(),
    email: zod.string().optional(),
    account_id: zod.string().optional(),
    account_uuid: zod.string().optional(),
    organization_uuid: zod.string().optional(),
    organization_name: zod.string().optional(),
    account: zod.unknown().optional(),
    organization: zod.unknown().optional(),
  })
  .loose();

export type ClaudePresentationText = {
  readonly pluginLabel?: LocalizedText;
  readonly pluginDescription?: LocalizedText;
  readonly adapterLabel: LocalizedText;
  readonly waitingForAuthorization: LocalizedText;
};

export const englishPresentationText: ClaudePresentationText = {
  pluginLabel: 'Claude Pro/Max',
  pluginDescription: 'Use a Claude Pro or Max account to access models',
  adapterLabel: 'Login with Claude',
  waitingForAuthorization: 'Waiting for Claude authorization',
};

export function createAnthropicClaudePlugin(
  presentationText: ClaudePresentationText = englishPresentationText,
  dependencies: ClaudeOAuthDependencies = {},
): PluginDescriptor<undefined> {
  const accountOptions = {
    schema: zod.object({}),
    form: [],
  } as const satisfies ConfigSpec<Record<string, never>>;
  const adapter: OAuthAdapter<Record<string, never>, ClaudeCredential> = {
    id: 'default',
    displayName: presentationText.adapterLabel,
    account: { options: accountOptions },
    credentials: credentialSchema,
    login: async (context, options) => {
      await accountOptions.schema.parseAsync(options);
      return await loginClaude(
        context,
        { waiting: presentationText.waitingForAuthorization },
        injectHostFetch(dependencies, context.fetch),
      );
    },
    credentialImports: {
      cpa: {
        types: ['claude'],
        async import(context, options, raw) {
          await accountOptions.schema.parseAsync(options);
          const source = cpaClaudeSchema.parse(raw);
          const email =
            normalizeClaudeEmail(source.email) ?? normalizeClaudeEmail(nestedString(source.account, 'email_address'));
          const accountId =
            nestedString(source.account, 'uuid') ??
            optionalString(source.account_id) ??
            optionalString(source.account_uuid);
          const organizationId = nestedString(source.organization, 'uuid') ?? optionalString(source.organization_uuid);
          const organizationName =
            nestedString(source.organization, 'name') ?? optionalString(source.organization_name);
          const resolved =
            accountId === undefined
              ? await resolveClaudeIdentity(source, {
                  phase: 'login',
                  fetch: dependencies.fetch ?? context.fetch ?? globalThis.fetch,
                  signal: context.signal,
                })
              : {};
          return claudeLoginResult({
            accessToken: source.access_token,
            refreshToken: source.refresh_token,
            expiresAt: cpaExpiresAt(source.expired),
            ...presentField('email', email ?? resolved.email),
            ...presentField('accountId', accountId ?? resolved.accountId),
            ...presentField('organizationId', organizationId ?? resolved.organizationId),
            ...presentField('organizationName', organizationName ?? resolved.organizationName),
          });
        },
      },
    },
    catalog: {
      policy: { kind: 'ttl', ttlMs: CLAUDE_CATALOG_TTL_MS },
      discover: (context) => discoverClaudeModels(context, injectHostFetch(dependencies, context.fetch)),
      initialFallback: initialClaudeCatalogFallback,
    },
    createRuntime: (context) => createClaudeRuntime(context, injectHostFetch(dependencies, context.fetch)),
    refreshCredential: async ({ credential, signal, fetch }) => {
      const refreshed = await refreshClaudeCredential(credential, {
        ...injectHostFetch(dependencies, fetch),
        signal,
      });
      return {
        value: refreshed,
        metadata: {
          expiresAt: refreshed.expiresAt,
          ...presentField('accountLabel', refreshed.email),
        },
      };
    },
  };
  return definePlugin((api) => api.oauth.register(adapter), {
    displayName: presentationText.pluginLabel ?? 'Claude Pro/Max',
    description: presentationText.pluginDescription ?? 'Use a Claude Pro or Max account to access models',
    icon: 'anthropic',
  });
}

function injectHostFetch(
  dependencies: ClaudeOAuthDependencies,
  hostFetch: RuntimeFetch | undefined,
): ClaudeOAuthDependencies {
  return {
    ...dependencies,
    ...(dependencies.fetch === undefined && hostFetch !== undefined ? { fetch: hostFetch } : {}),
  };
}

function cpaExpiresAt(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function nestedString(container: unknown, key: string): string | undefined {
  return isPlainObject(container) ? optionalString(container[key]) : undefined;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function presentField<K extends string>(key: K, value: string | undefined): { readonly [P in K]?: string } {
  return value === undefined ? {} : { [key]: value };
}
