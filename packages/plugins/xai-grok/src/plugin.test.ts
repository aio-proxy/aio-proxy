import { expect, test } from 'bun:test';

import type { OAuthAdapter, PluginDescriptor } from '@aio-proxy/plugin-sdk';

import xaiGrokPlugin, { createXAIGrokPlugin, XAI_GROK_PLUGIN_VERSION } from '.';
import packageJson from '../package.json' with { type: 'json' };
import { xaiLoginResult } from './oauth';
import type { XAIGrokCredential } from './schema';

test('exports a versioned xAI Grok OAuth descriptor', async () => {
  const adapter = await adapterFrom(xaiGrokPlugin);
  expect(adapter.id).toBe('default');
  expect(adapter.displayName).toBe('Login with xAI Grok');
  expect(xaiGrokPlugin.metadata.icon).toBe('xai');
  expect(adapter.account.options.form).toEqual([]);
  expect(adapter.catalog.policy).toEqual({ kind: 'ttl', ttlMs: 6 * 60 * 60_000 });
  expect(adapter.quota?.read).toBeFunction();
  expect(adapter.quota?.reset).toBeUndefined();
  expect(XAI_GROK_PLUGIN_VERSION).toBe(packageJson.version);
});

test('accepts localized copy without adding account options', async () => {
  const adapter = await adapterFrom(
    createXAIGrokPlugin({
      pluginLabel: 'xAI Grok',
      pluginDescription: 'Compte Grok',
      adapterLabel: 'Connexion Grok',
      deviceInstructions: 'Saisissez le code',
      waitingForAuthorization: 'Autorisation xAI en attente',
    }),
  );
  expect(adapter.displayName).toBe('Connexion Grok');
  await expect(adapter.account.options.schema.parseAsync({})).resolves.toEqual({});
});

test('imports CPA xai credentials with native identity precedence', async () => {
  const adapter = await adapterFrom(createXAIGrokPlugin());
  const importer = adapter.credentialImports?.cpa;
  if (importer === undefined) throw new Error('CPA importer not registered');
  const context = { progress: () => {}, signal: new AbortController().signal };
  const imported = await importer.import(
    context,
    {},
    {
      type: 'xai',
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expired: '2026-08-24T12:00:00Z',
      email: 'Person@Example.com',
      sub: 'subject-1',
      id_token: 'must-not-persist',
      base_url: 'must-not-persist',
    },
  );
  const credentials = {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    expiresAt: Date.parse('2026-08-24T12:00:00Z'),
    email: 'Person@Example.com',
    subject: 'subject-1',
  };
  expect(imported).toEqual(xaiLoginResult(credentials));
  expect(Object.keys(imported.credentials).toSorted()).toEqual([
    'accessToken',
    'email',
    'expiresAt',
    'refreshToken',
    'subject',
  ]);

  const invalidExpiry = await importer.import(
    context,
    {},
    {
      type: 'xai',
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      expired: 'invalid',
    },
  );
  expect(invalidExpiry.expiresAt).toBe(0);
  expect(invalidExpiry.credentials.expiresAt).toBe(0);
});

async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<Record<string, never>, XAIGrokCredential>> {
  let registered: OAuthAdapter<Record<string, never>, XAIGrokCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(adapter) {
          registered = adapter as unknown as OAuthAdapter<Record<string, never>, XAIGrokCredential>;
        },
      },
    },
    undefined,
  );
  if (registered === undefined) throw new Error('xAI Grok OAuth adapter was not registered');
  return registered;
}
