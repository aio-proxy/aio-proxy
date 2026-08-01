import {
  type ConfigSpec,
  definePlugin,
  type LocalizedText,
  type OAuthAdapter,
  type PluginDescriptor,
  zod,
} from '@aio-proxy/plugin-sdk';

import { initialCursorCatalogFallback, staticCursorCatalog } from './catalog';
import { type CursorOAuthDependencies, loginCursor } from './oauth';
import { credentialSchema, type CursorCredential } from './schema';

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
  dependencies: CursorOAuthDependencies = {},
): PluginDescriptor<undefined> {
  const accountOptions = { schema: zod.object({}), form: [] } as const satisfies ConfigSpec<Record<string, never>>;
  const adapter: OAuthAdapter<Record<string, never>, CursorCredential> = {
    id: 'default',
    label: presentationText.adapterLabel,
    icon: 'cursor',
    account: { options: accountOptions },
    credentials: credentialSchema,
    login: async (context, options) => {
      await accountOptions.schema.parseAsync(options);
      return await loginCursor(context, { waiting: presentationText.waitingForAuthorization }, dependencies);
    },
    catalog: {
      policy: { kind: 'static' },
      discover: () => Promise.resolve(staticCursorCatalog()),
      initialFallback: initialCursorCatalogFallback,
    },
    createRuntime: async () => {
      throw new Error('Cursor runtime is not implemented in Phase 1');
    },
  };
  return definePlugin((api) => api.oauth.register(adapter), {
    label: presentationText.pluginLabel ?? 'Cursor',
    description: presentationText.pluginDescription ?? 'Use a Cursor account to access models',
  });
}
