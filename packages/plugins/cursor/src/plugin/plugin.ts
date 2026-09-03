import {
  type ConfigSpec,
  definePlugin,
  type LocalizedText,
  type OAuthAdapter,
  type PluginDescriptor,
  zod,
} from '@aio-proxy/plugin-sdk';

import {
  CURSOR_CATALOG_TTL_MS,
  defaultCursorAliases,
  discoverCursorCatalog,
  initialCursorCatalogFallback,
} from '../catalog';
import { loginCursor } from '../oauth';
import { readCursorQuota } from '../quota/index';
import { createCursorRuntime, type CursorRuntimeDependencies } from '../runtime';
import { credentialSchema, type CursorCredential } from '../schema';

export type CursorPresentationText = {
  readonly pluginLabel?: LocalizedText;
  readonly pluginDescription?: LocalizedText;
  readonly adapterLabel: LocalizedText;
  readonly waitingForAuthorization: LocalizedText;
};

export const englishPresentationText: CursorPresentationText = {
  pluginLabel: 'Cursor',
  pluginDescription: 'Use a Cursor account to access models',
  adapterLabel: 'Login with Cursor',
  waitingForAuthorization: 'Waiting for Cursor authorization',
};

export function createCursorPlugin(
  presentationText: CursorPresentationText = englishPresentationText,
  dependencies: CursorRuntimeDependencies = {},
): PluginDescriptor<undefined> {
  const accountOptions = { schema: zod.object({}), form: [] } as const satisfies ConfigSpec<Record<string, never>>;
  const adapter: OAuthAdapter<Record<string, never>, CursorCredential> = {
    id: 'default',
    displayName: presentationText.adapterLabel,
    supportsProxy: false,
    account: { options: accountOptions },
    credentials: credentialSchema,
    login: async (context, options) => {
      await accountOptions.schema.parseAsync(options);
      return await loginCursor(context, { waiting: presentationText.waitingForAuthorization }, dependencies);
    },
    catalog: {
      policy: { kind: 'ttl', ttlMs: CURSOR_CATALOG_TTL_MS },
      discover: (context) => discoverCursorCatalog(context, dependencies),
      initialFallback: initialCursorCatalogFallback,
      defaultAliases: defaultCursorAliases,
    },
    createRuntime: (context) => createCursorRuntime(context, dependencies),
    quota: { read: (context) => readCursorQuota(context, dependencies) },
  };
  return definePlugin((api) => api.oauth.register(adapter), {
    displayName: presentationText.pluginLabel ?? 'Cursor',
    description: presentationText.pluginDescription ?? 'Use a Cursor account to access models',
    icon: 'cursor',
  });
}
