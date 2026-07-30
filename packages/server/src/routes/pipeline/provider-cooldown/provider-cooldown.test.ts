import { describe, expect, test } from 'bun:test';

import { ProviderCooldownStore } from './provider-cooldown';

describe('ProviderCooldownStore', () => {
  test('remainingMs is 0 before any cooldown', () => {
    expect(new ProviderCooldownStore().remainingMs('p', 'm')).toBe(0);
  });

  test('cool sets a positive window keyed by provider and model', () => {
    const store = new ProviderCooldownStore();
    store.cool('p', 'm', 5_000);
    expect(store.remainingMs('p', 'm')).toBeGreaterThan(0);
    expect(store.remainingMs('p', 'm')).toBeLessThanOrEqual(5_000);
    expect(store.remainingMs('p', 'other')).toBe(0);
    expect(store.remainingMs('other', 'm')).toBe(0);
  });

  test('cool ignores non-positive ttl', () => {
    const store = new ProviderCooldownStore();
    store.cool('p', 'm', 0);
    store.cool('p', 'm', -1);
    expect(store.remainingMs('p', 'm')).toBe(0);
  });

  test('an expired cooldown reports 0', async () => {
    const store = new ProviderCooldownStore();
    store.cool('p', 'm', 20);
    await Bun.sleep(40);
    expect(store.remainingMs('p', 'm')).toBe(0);
  });

  test('keys with special characters do not collide', () => {
    const store = new ProviderCooldownStore();
    store.cool('a', 'b\u0000c', 5_000); // model contains NUL
    expect(store.remainingMs('a\u0000b', 'c')).toBe(0); // different (provider, model) must not alias
  });
});
