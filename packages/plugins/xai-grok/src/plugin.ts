import {
  type ConfigSpec,
  definePlugin,
  type LocalizedText,
  type OAuthAdapter,
  type PluginDescriptor,
  zod,
} from '@aio-proxy/plugin-sdk';

import { discoverXAIGrokModels, initialXAIGrokCatalogFallback, XAI_GROK_CATALOG_TTL_MS } from './catalog';
import { loginXAIGrok, type XAIGrokOAuthOptions } from './oauth';
import { readXAIGrokQuota } from './quota';
import { createXAIGrokRuntime } from './runtime/index';
import { credentialSchema, type XAIGrokCredential } from './schema';

export type XAIGrokPresentationText = {
  readonly pluginLabel?: LocalizedText;
  readonly pluginDescription?: LocalizedText;
  readonly adapterLabel: LocalizedText;
  readonly deviceInstructions: LocalizedText;
  readonly waitingForAuthorization: LocalizedText;
};

export const englishPresentationText: XAIGrokPresentationText = {
  pluginLabel: 'xAI Grok',
  pluginDescription: 'Use a SuperGrok or X Premium+ account to access Grok models',
  adapterLabel: 'Login with xAI Grok',
  deviceInstructions: 'Enter code',
  waitingForAuthorization: 'Waiting for xAI authorization',
};

export function createXAIGrokPlugin(
  presentationText: XAIGrokPresentationText = englishPresentationText,
  dependencies: Pick<XAIGrokOAuthOptions, 'fetch' | 'now' | 'sleep'> = {},
): PluginDescriptor<undefined> {
  const accountOptions = {
    schema: zod.object({}),
    form: [],
  } as const satisfies ConfigSpec<Record<string, never>>;
  const adapter: OAuthAdapter<Record<string, never>, XAIGrokCredential> = {
    id: 'default',
    displayName: presentationText.adapterLabel,
    account: { options: accountOptions },
    credentials: credentialSchema,
    login: async (context, options) => {
      await accountOptions.schema.parseAsync(options);
      return await loginXAIGrok(context, {
        ...dependencies,
        ...(dependencies.fetch === undefined && context.fetch !== undefined ? { fetch: context.fetch } : {}),
        deviceInstructions: presentationText.deviceInstructions,
        waitingForAuthorization: presentationText.waitingForAuthorization,
      });
    },
    catalog: {
      policy: { kind: 'ttl', ttlMs: XAI_GROK_CATALOG_TTL_MS },
      discover: (context) =>
        discoverXAIGrokModels(context, {
          ...dependencies,
          ...(dependencies.fetch === undefined && context.fetch !== undefined ? { fetch: context.fetch } : {}),
        }),
      initialFallback: initialXAIGrokCatalogFallback,
    },
    quota: {
      read: (context) =>
        readXAIGrokQuota(context, {
          ...dependencies,
          ...(dependencies.fetch === undefined && context.fetch !== undefined ? { fetch: context.fetch } : {}),
        }),
    },
    createRuntime: (context) => createXAIGrokRuntime(context, dependencies),
  };
  return definePlugin(
    (api) => {
      api.oauth.register(adapter);
    },
    {
      displayName: presentationText.pluginLabel ?? 'xAI Grok',
      description: presentationText.pluginDescription ?? 'Use a SuperGrok or X Premium+ account to access Grok models',
      icon: 'xai',
    },
  );
}
