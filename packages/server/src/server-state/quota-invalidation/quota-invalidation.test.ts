import { expect, test } from 'bun:test';

import type { PluginRepository, StoredAccount } from '@aio-proxy/core';
import { ConfigSchema, type Config } from '@aio-proxy/types';

import type { OAuthQuotaCache } from '../../plugin-quota';
import { createQuotaIdentityTracker } from './quota-invalidation';

function recordingCache(): OAuthQuotaCache & { readonly invalidated: string[] } {
  const invalidated: string[] = [];
  return {
    invalidated,
    read: async () => {
      throw new Error('not called');
    },
    warm: () => {},
    invalidate: (providerId) => {
      invalidated.push(providerId);
    },
  };
}

type Stored = { accounts: Record<string, StoredAccount>; secrets: Record<string, number> };

function repositoryOf(stored: Stored): Pick<PluginRepository, 'readAccount' | 'readPluginSecret'> {
  return {
    readAccount: (providerId) => stored.accounts[providerId] ?? null,
    readPluginSecret: (plugin) =>
      stored.secrets[plugin] === undefined ? null : { value: {}, revision: stored.secrets[plugin] },
  };
}

function account(overrides: Partial<StoredAccount> = {}): StoredAccount {
  return {
    providerId: 'person',
    plugin: '@example/oauth',
    capability: 'default',
    fingerprint: 'fp',
    options: {},
    secrets: {},
    credential: {},
    revision: 1,
    runtimeRevision: 1,
    updatedAt: 0,
    ...overrides,
  };
}

function config(overrides: { proxy?: string; pluginOptions?: unknown } = {}): Config {
  return ConfigSchema.parse({
    ...(overrides.proxy === undefined ? {} : { proxy: overrides.proxy }),
    plugins: overrides.pluginOptions === undefined ? ['@example/oauth'] : [['@example/oauth', overrides.pluginOptions]],
    providers: {
      person: { kind: 'oauth', plugin: '@example/oauth', capability: 'default' },
      gateway: { kind: 'api', protocol: 'openai-compatible', baseURL: 'https://example.test' },
    },
  });
}

// Each case leaves `config.providers.person` byte-identical and still changes what the quota read
// would return, so comparing the Provider config entry alone would miss all of them.
const identityChanges: readonly [string, () => { cache: ReturnType<typeof recordingCache> }][] = [
  [
    'a reauthentication that bumps the account revision',
    () => {
      const stored: Stored = { accounts: { person: account() }, secrets: {} };
      const cache = recordingCache();
      const tracker = createQuotaIdentityTracker(cache, repositoryOf(stored), config());
      stored.accounts['person'] = account({ revision: 2, runtimeRevision: 2, fingerprint: 'other' });
      tracker.reconcile(config());
      return { cache };
    },
  ],
  [
    'a rotated plugin secret',
    () => {
      const stored: Stored = { accounts: { person: account() }, secrets: { '@example/oauth': 1 } };
      const cache = recordingCache();
      const tracker = createQuotaIdentityTracker(cache, repositoryOf(stored), config());
      stored.secrets['@example/oauth'] = 2;
      tracker.reconcile(config());
      return { cache };
    },
  ],
  [
    'edited plugin options',
    () => {
      const stored: Stored = { accounts: { person: account() }, secrets: {} };
      const cache = recordingCache();
      const tracker = createQuotaIdentityTracker(cache, repositoryOf(stored), config());
      tracker.reconcile(config({ pluginOptions: { region: 'eu' } }));
      return { cache };
    },
  ],
  [
    'a changed global proxy',
    () => {
      const stored: Stored = { accounts: { person: account() }, secrets: {} };
      const cache = recordingCache();
      const tracker = createQuotaIdentityTracker(cache, repositoryOf(stored), config());
      tracker.reconcile(config({ proxy: 'http://127.0.0.1:8080' }));
      return { cache };
    },
  ],
];

test.each(identityChanges)('invalidates the cached quota after %s', (_name, run) => {
  expect(run().cache.invalidated).toEqual(['person']);
});

test('an unchanged commit leaves every cached snapshot in place', () => {
  const stored: Stored = { accounts: { person: account() }, secrets: { '@example/oauth': 1 } };
  const cache = recordingCache();
  const tracker = createQuotaIdentityTracker(cache, repositoryOf(stored), config());

  tracker.reconcile(config());

  expect(cache.invalidated).toEqual([]);
});

test('a Provider that disappears loses its snapshot, because its ID is reusable', () => {
  const stored: Stored = { accounts: { person: account() }, secrets: {} };
  const cache = recordingCache();
  const tracker = createQuotaIdentityTracker(cache, repositoryOf(stored), config());

  tracker.reconcile(
    ConfigSchema.parse({ plugins: ['@example/oauth'], providers: { gateway: { kind: 'api', protocol: 'anthropic' } } }),
  );

  expect(cache.invalidated).toEqual(['person']);
});
