import {
  type ConfigSpec,
  definePlugin,
  type LocalizedText,
  type OAuthAdapter,
  type PluginDescriptor,
  zod,
} from '@aio-proxy/plugin-sdk';

import { discoverMuseCodeModels, initialMuseCodeCatalogFallback, MUSE_CODE_CATALOG_TTL_MS } from '../catalog';
import { loginMuseCode, type MuseCodeOAuthOptions } from '../oauth';
import { readMuseCodeQuota } from '../quota';
import { createMuseCodeRuntime } from '../runtime';
import { credentialSchema, type MuseCodeCredential } from '../schema';

export type MuseCodePresentationText = {
  readonly pluginLabel?: LocalizedText;
  readonly pluginDescription?: LocalizedText;
  readonly adapterLabel: LocalizedText;
  readonly deviceInstructions: LocalizedText;
  readonly waitingForAuthorization: LocalizedText;
};

export const englishPresentationText: MuseCodePresentationText = {
  pluginLabel: 'Muse Code',
  pluginDescription: 'Use a Muse Code subscription to access Meta models',
  adapterLabel: 'Login with Muse Code',
  deviceInstructions: 'Enter code',
  waitingForAuthorization: 'Waiting for Muse authorization',
};

export function createMuseCodePlugin(
  presentationText: MuseCodePresentationText = englishPresentationText,
  dependencies: Pick<MuseCodeOAuthOptions, 'fetch' | 'now' | 'sleep'> = {},
): PluginDescriptor<undefined> {
  const accountOptions = {
    schema: zod.object({}),
    form: [],
  } as const satisfies ConfigSpec<Record<string, never>>;
  const adapter: OAuthAdapter<Record<string, never>, MuseCodeCredential> = {
    id: 'default',
    displayName: presentationText.adapterLabel,
    account: { options: accountOptions },
    credentials: credentialSchema,
    login: async (context, options) => {
      await accountOptions.schema.parseAsync(options);
      return await loginMuseCode(context, {
        ...dependencies,
        ...(dependencies.fetch === undefined && context.fetch !== undefined ? { fetch: context.fetch } : {}),
        deviceInstructions: presentationText.deviceInstructions,
        waitingForAuthorization: presentationText.waitingForAuthorization,
      });
    },
    catalog: {
      policy: { kind: 'ttl', ttlMs: MUSE_CODE_CATALOG_TTL_MS },
      discover: (context) =>
        discoverMuseCodeModels(context, {
          ...dependencies,
          ...(dependencies.fetch === undefined && context.fetch !== undefined ? { fetch: context.fetch } : {}),
        }),
      initialFallback: initialMuseCodeCatalogFallback,
    },
    quota: {
      read: (context) =>
        readMuseCodeQuota(context, {
          ...dependencies,
          ...(dependencies.fetch === undefined && context.fetch !== undefined ? { fetch: context.fetch } : {}),
        }),
    },
    createRuntime: (context) => createMuseCodeRuntime(context, dependencies),
  };
  return definePlugin(
    (api) => {
      api.oauth.register(adapter);
    },
    {
      displayName: presentationText.pluginLabel ?? 'Muse Code',
      description: presentationText.pluginDescription ?? 'Use a Muse Code subscription to access Meta models',
      icon: 'meta',
    },
  );
}
