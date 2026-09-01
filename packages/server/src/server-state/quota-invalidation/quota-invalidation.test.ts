import { expect, test } from 'bun:test';

import type { OAuthQuotaCache } from '../../plugin-quota';
import { invalidateReconfiguredQuota } from './quota-invalidation';

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

test('only providers whose config changed, appeared, or disappeared lose their cached quota', () => {
  const cache = recordingCache();

  invalidateReconfiguredQuota(
    cache,
    {
      untouched: { plugin: '@example/oauth', capability: 'default' },
      repointed: { capability: 'default' },
      removed: {},
    },
    { untouched: { plugin: '@example/oauth', capability: 'default' }, repointed: { capability: 'other' }, added: {} },
  );

  expect([...cache.invalidated].sort()).toEqual(['added', 'removed', 'repointed']);
});
