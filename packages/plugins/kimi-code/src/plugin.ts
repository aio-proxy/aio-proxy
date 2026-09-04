import {
  type ConfigSpec,
  definePlugin,
  type LocalizedText,
  type OAuthAdapter,
  type PluginDescriptor,
  zod,
} from '@aio-proxy/plugin-sdk';

import { discoverKimiCatalog, KIMI_CATALOG_TTL_MS, staticKimiCatalog } from './catalog';
import { kimiLoginResult, loginKimi, refreshKimiCredential } from './oauth';
import type { KimiCredential, KimiOAuthDependencies } from './oauth';
import { readKimiQuota } from './quota';
import { createKimiRuntime } from './runtime/index';

export type KimiCodePresentationText = {
  readonly pluginLabel?: LocalizedText;
  readonly pluginDescription?: LocalizedText;
  readonly adapterLabel: LocalizedText;
  readonly deviceInstructions: LocalizedText;
  readonly waitingForAuthorization: LocalizedText;
};

export const englishPresentationText: KimiCodePresentationText = {
  pluginLabel: 'Kimi Code',
  pluginDescription: 'Use a Kimi Code account to access models',
  adapterLabel: 'Login with Kimi Code',
  deviceInstructions: 'Enter code',
  waitingForAuthorization: 'Waiting for Kimi authorization',
};

const cpaKimiSchema = zod
  .object({
    type: zod.literal('kimi'),
    access_token: zod.string().trim().min(1),
    refresh_token: zod.string().trim().min(1),
    device_id: zod.string().trim().min(1).optional(),
    expired: zod.unknown().optional(),
  })
  .loose();

function cpaExpiresAt(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export function createKimiCodePlugin(
  presentationText: KimiCodePresentationText = englishPresentationText,
  dependencies: KimiOAuthDependencies = {},
): PluginDescriptor<undefined> {
  const accountOptions = {
    schema: zod.object({}),
    form: [],
  } as const satisfies ConfigSpec<Record<string, never>>;
  const adapter: OAuthAdapter<Record<string, never>, KimiCredential> = {
    id: 'default',
    displayName: presentationText.adapterLabel,
    account: { options: accountOptions },
    credentials: zod.object({
      accessToken: zod.string().min(1),
      refreshToken: zod.string().min(1),
      expiresAt: zod.number().int(),
      deviceId: zod.string().min(1),
      email: zod.string().optional(),
    }),
    login: async (context, options) => {
      await accountOptions.schema.parseAsync(options);
      return await loginKimi(
        context,
        {
          instructions: presentationText.deviceInstructions,
          waiting: presentationText.waitingForAuthorization,
        },
        {
          ...dependencies,
          ...(dependencies.fetch === undefined && context.fetch !== undefined ? { fetch: context.fetch } : {}),
        },
      );
    },
    credentialImports: {
      cpa: {
        types: ['kimi'],
        async import(_context, options, raw) {
          await accountOptions.schema.parseAsync(options);
          const source = cpaKimiSchema.parse(raw);
          return await kimiLoginResult({
            accessToken: source.access_token,
            refreshToken: source.refresh_token,
            expiresAt: cpaExpiresAt(source.expired),
            deviceId: source.device_id ?? dependencies.deviceId?.() ?? crypto.randomUUID().replaceAll('-', ''),
          });
        },
      },
    },
    catalog: {
      policy: { kind: 'ttl', ttlMs: KIMI_CATALOG_TTL_MS },
      discover: (context) =>
        discoverKimiCatalog(context, {
          ...dependencies,
          ...(dependencies.fetch === undefined && context.fetch !== undefined ? { fetch: context.fetch } : {}),
        }),
      initialFallback: (error) =>
        error instanceof DOMException && error.name === 'AbortError' ? undefined : staticKimiCatalog(),
    },
    createRuntime: (context) => createKimiRuntime(context, dependencies),
    quota: {
      read: (context) =>
        readKimiQuota(context, {
          ...dependencies,
          ...(dependencies.fetch === undefined && context.fetch !== undefined ? { fetch: context.fetch } : {}),
        }),
    },
    refreshCredential: async ({ credential, signal, fetch }) => {
      const refreshed = await refreshKimiCredential(credential, {
        ...dependencies,
        signal,
        ...(dependencies.fetch === undefined && fetch !== undefined ? { fetch } : {}),
      });
      return {
        value: refreshed,
        metadata: {
          expiresAt: refreshed.expiresAt,
          ...(refreshed.email === undefined ? {} : { accountLabel: refreshed.email }),
        },
      };
    },
  };

  return definePlugin((api) => api.oauth.register(adapter), {
    displayName: presentationText.pluginLabel ?? 'Kimi Code',
    description: presentationText.pluginDescription ?? 'Use a Kimi Code account to access models',
    icon: 'moonshot',
  });
}
