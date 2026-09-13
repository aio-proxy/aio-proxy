import {
  type ConfigSpec,
  definePlugin,
  type LocalizedText,
  type OAuthAdapter,
  type PluginDescriptor,
  zod,
} from '@aio-proxy/plugin-sdk';

import {
  discoverOpenRouterModels,
  initialOpenRouterCatalogFallback,
  OPENROUTER_CATALOG_TTL_MS,
} from '../catalog/index';
import { loginOpenRouter, type OpenRouterOAuthOptions } from '../oauth/index';
import { readOpenRouterQuota } from '../quota/index';
import { createOpenRouterRuntime } from '../runtime/index';
import { credentialSchema, type OpenRouterCredential } from '../schema/index';

export type OpenRouterPresentationText = {
  readonly pluginLabel?: LocalizedText;
  readonly pluginDescription?: LocalizedText;
  readonly adapterLabel: LocalizedText;
  readonly waitingForAuthorization?: LocalizedText;
};

export const englishPresentationText: OpenRouterPresentationText = {
  pluginLabel: 'OpenRouter',
  pluginDescription: 'Sign in with OpenRouter to mint an API key',
  adapterLabel: 'Login with OpenRouter',
  waitingForAuthorization: 'Waiting for OpenRouter authorization',
};

export function createOpenRouterPlugin(
  presentationText: OpenRouterPresentationText = englishPresentationText,
  dependencies: OpenRouterOAuthOptions = {},
): PluginDescriptor<undefined> {
  const accountOptions = {
    schema: zod.object({}),
    form: [],
  } as const satisfies ConfigSpec<Record<string, never>>;
  const adapter: OAuthAdapter<Record<string, never>, OpenRouterCredential> = {
    id: 'default',
    displayName: presentationText.adapterLabel,
    account: { options: accountOptions },
    credentialSync: { formatVersion: 1 },
    credentials: credentialSchema,
    login: async (context, options) => {
      await accountOptions.schema.parseAsync(options);
      if (presentationText.waitingForAuthorization !== undefined) {
        context.progress(presentationText.waitingForAuthorization);
      }
      return await loginOpenRouter(context, {
        ...dependencies,
        ...(dependencies.fetch === undefined && context.fetch !== undefined ? { fetch: context.fetch } : {}),
      });
    },
    catalog: {
      policy: { kind: 'ttl', ttlMs: OPENROUTER_CATALOG_TTL_MS },
      discover: (context) =>
        discoverOpenRouterModels(context, {
          ...dependencies,
          ...(dependencies.fetch === undefined && context.fetch !== undefined ? { fetch: context.fetch } : {}),
        }),
      initialFallback: initialOpenRouterCatalogFallback,
    },
    quota: {
      read: (context) =>
        readOpenRouterQuota(context, {
          ...dependencies,
          ...(dependencies.fetch === undefined && context.fetch !== undefined ? { fetch: context.fetch } : {}),
        }),
    },
    createRuntime: (context) => createOpenRouterRuntime(context, dependencies),
  };
  return definePlugin(
    (api) => {
      api.oauth.register(adapter);
    },
    {
      displayName: presentationText.pluginLabel ?? 'OpenRouter',
      description: presentationText.pluginDescription ?? 'Sign in with OpenRouter to mint an API key',
      icon: 'openrouter',
    },
  );
}
