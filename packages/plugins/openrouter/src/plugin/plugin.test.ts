import { expect, test } from 'bun:test';

import type { OAuthAdapter, PluginDescriptor } from '@aio-proxy/plugin-sdk';

import packageJson from '../../package.json' with { type: 'json' };
import { OPENROUTER_PLUGIN_VERSION } from '../index';
import type { OpenRouterCredential } from '../schema/index';
import { createOpenRouterPlugin, englishPresentationText } from './plugin';

test('exports a versioned OpenRouter OAuth descriptor', async () => {
  const plugin = createOpenRouterPlugin();
  const adapter = await adapterFrom(plugin);
  expect(adapter.id).toBe('default');
  expect(adapter.displayName).toBe('Login with OpenRouter');
  expect(plugin.metadata.icon).toBe('openrouter');
  expect(adapter.account.options.form).toEqual([]);
  expect(adapter.catalog.policy).toEqual({ kind: 'ttl', ttlMs: 6 * 60 * 60_000 });
  expect(adapter.refreshCredential).toBeUndefined();
  expect(adapter.credentialImports).toBeUndefined();
  expect(adapter.quota?.read).toBeFunction();
  expect(adapter.quota?.reset).toBeUndefined();
  expect(OPENROUTER_PLUGIN_VERSION).toBe(packageJson.version);
  await expect(adapter.account.options.schema.parseAsync({})).resolves.toEqual({});
});

test('accepts localized copy without adding account options', async () => {
  const adapter = await adapterFrom(
    createOpenRouterPlugin({
      ...englishPresentationText,
      pluginLabel: 'OpenRouter',
      pluginDescription: 'Connexion OpenRouter',
      adapterLabel: 'Connexion OpenRouter',
    }),
  );
  expect(adapter.displayName).toBe('Connexion OpenRouter');
});

async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<Record<string, never>, OpenRouterCredential>> {
  let registered: OAuthAdapter<Record<string, never>, OpenRouterCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(adapter) {
          registered = adapter as unknown as OAuthAdapter<Record<string, never>, OpenRouterCredential>;
        },
      },
    },
    undefined,
  );
  if (registered === undefined) throw new Error('OpenRouter OAuth adapter was not registered');
  return registered;
}
