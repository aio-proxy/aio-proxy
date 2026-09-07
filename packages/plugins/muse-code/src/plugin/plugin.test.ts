import { expect, test } from 'bun:test';

import type { OAuthAdapter, PluginDescriptor } from '@aio-proxy/plugin-sdk';

import museCodePlugin, { createMuseCodePlugin, MUSE_CODE_PLUGIN_VERSION } from '..';
import packageJson from '../../package.json' with { type: 'json' };
import type { MuseCodeCredential } from '../schema';

test('exports a versioned Muse Code OAuth descriptor', async () => {
  const adapter = await adapterFrom(museCodePlugin);
  expect(adapter.id).toBe('default');
  expect(adapter.displayName).toBe('Login with Muse Code');
  expect(museCodePlugin.metadata.icon).toBe('meta');
  expect(adapter.account.options.form).toEqual([]);
  await expect(adapter.account.options.schema.parseAsync({})).resolves.toEqual({});
  expect(adapter.catalog.policy).toEqual({ kind: 'ttl', ttlMs: 6 * 60 * 60_000 });
  expect(adapter.quota?.read).toBeFunction();
  expect(adapter.quota?.reset).toBeUndefined();
  expect(adapter.refreshCredential).toBeUndefined();
  expect(adapter.credentialImports).toBeUndefined();
  expect(MUSE_CODE_PLUGIN_VERSION).toBe(packageJson.version);
});

test('accepts localized copy without adding account options', async () => {
  const adapter = await adapterFrom(
    createMuseCodePlugin({
      pluginLabel: 'Muse Code',
      pluginDescription: 'Compte Muse',
      adapterLabel: 'Connexion Muse',
      deviceInstructions: 'Saisissez le code',
      waitingForAuthorization: 'Autorisation Muse en attente',
    }),
  );
  expect(adapter.displayName).toBe('Connexion Muse');
});

async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<Record<string, never>, MuseCodeCredential>> {
  let registered: OAuthAdapter<Record<string, never>, MuseCodeCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(adapter) {
          registered = adapter as OAuthAdapter<Record<string, never>, MuseCodeCredential>;
        },
      },
    },
    undefined,
  );
  if (registered === undefined) throw new Error('Muse Code OAuth adapter was not registered');
  return registered;
}
