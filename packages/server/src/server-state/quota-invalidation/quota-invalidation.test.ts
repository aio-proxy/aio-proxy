import { expect, test } from 'bun:test';

import { ConfigSchema } from '@aio-proxy/types';

import type { OAuthQuotaCache } from '../../plugin-quota';
import { createQuotaIdentityTracker, type QuotaIdentitySource } from './quota-invalidation';

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

/**
 * The runtime identity is an opaque digest of everything a materialized OAuth runtime depends on —
 * plugin version, plugin options (including the stored plugin secret), account options, the
 * account's `runtimeRevision`, the effective proxy, and the request transforms. The tracker only
 * compares it, so a fixture only has to vary the string.
 */
function snapshot(identities: Record<string, string | undefined>, apiProviders: string[] = []): QuotaIdentitySource {
  return {
    config: ConfigSchema.parse({
      plugins: ['@example/oauth'],
      providers: {
        ...Object.fromEntries(
          Object.keys(identities).map((id) => [id, { kind: 'oauth', plugin: '@example/oauth', capability: 'default' }]),
        ),
        ...Object.fromEntries(
          apiProviders.map((id) => [id, { kind: 'api', protocol: 'openai-compatible', baseURL: 'https://ex.test' }]),
        ),
      },
    }),
    runtimeCache: new Map(
      Object.entries(identities).flatMap(([id, identity]) =>
        identity === undefined ? [] : [[id, { identity } as never] as const],
      ),
    ),
  };
}

test('a commit that moves a runtime identity drops that Provider’s cached quota', () => {
  // Every input the quota read depends on — a reauthentication, a rotated plugin secret, edited
  // plugin or account options, a changed proxy — moves this digest without necessarily touching
  // `config.providers[id]`, which is why the tracker compares the digest and not the config entry.
  const cache = recordingCache();
  const tracker = createQuotaIdentityTracker(cache, snapshot({ person: 'sha256:a', other: 'sha256:x' }));

  tracker.reconcile(snapshot({ person: 'sha256:b', other: 'sha256:x' }));

  expect(cache.invalidated).toEqual(['person']);
});

test('an unchanged commit leaves every cached snapshot in place', () => {
  const cache = recordingCache();
  const tracker = createQuotaIdentityTracker(cache, snapshot({ person: 'sha256:a' }, ['gateway']));

  tracker.reconcile(snapshot({ person: 'sha256:a' }, ['gateway']));

  expect(cache.invalidated).toEqual([]);
});

test('a Provider that disappears loses its snapshot, because its ID is reusable', () => {
  const cache = recordingCache();
  const tracker = createQuotaIdentityTracker(cache, snapshot({ person: 'sha256:a' }));

  tracker.reconcile(snapshot({}, ['gateway']));

  expect(cache.invalidated).toEqual(['person']);
});

test('a Provider that recovers a runtime drops the failure it cached while unavailable', () => {
  // An unavailable Provider has no cache entry: its quota read is failing for the same reason its
  // runtime would not materialize, and that failure is cached as a retryable stale entry.
  const cache = recordingCache();
  const tracker = createQuotaIdentityTracker(cache, snapshot({ person: undefined }));

  tracker.reconcile(snapshot({ person: 'sha256:a' }));

  expect(cache.invalidated).toEqual(['person']);
});
