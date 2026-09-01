import { describe, expect, test } from 'bun:test';

import type { getProviders, hasCachedModelsCatalog } from '@aio-proxy/core';

import { catalogCachedOrWarming } from './warm-catalog';

/** A stand-in for the on-disk provider map: only `getProviders` may populate it. */
function fakeCatalog(present: boolean) {
  const calls = { getProviders: 0 };
  return {
    calls,
    hasCachedModelsCatalog: (async () => present) as typeof hasCachedModelsCatalog,
    getProviders: (async () => {
      calls.getProviders += 1;
      present = true;
      return {};
    }) as unknown as typeof getProviders,
  };
}

describe('catalogCachedOrWarming', () => {
  test('a cold catalog warms through the same cache the check reads, so rebuilds converge', async () => {
    const catalog = fakeCatalog(false);
    let warmed = 0;

    expect(await catalogCachedOrWarming(() => (warmed += 1), catalog)).toBe(false);
    await Bun.sleep(0);
    expect(warmed).toBe(1);

    // The rebuild `onCatalogWarmed` queued must now see a warm catalog. Warming the
    // per-model LRU instead would leave this false and re-fire the callback forever.
    expect(await catalogCachedOrWarming(() => (warmed += 1), catalog)).toBe(true);
    await Bun.sleep(0);
    expect(warmed).toBe(1);
    expect(catalog.calls.getProviders).toBe(1);
  });

  test('a failed warm does not queue a rebuild that would find the catalog still cold', async () => {
    let warmed = 0;

    const cached = await catalogCachedOrWarming(() => (warmed += 1), {
      hasCachedModelsCatalog: (async () => false) as typeof hasCachedModelsCatalog,
      getProviders: (async () => {
        throw new Error('offline');
      }) as unknown as typeof getProviders,
    });
    await Bun.sleep(0);

    expect(cached).toBe(false);
    expect(warmed).toBe(0);
  });
});
