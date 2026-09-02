import { expect, test } from 'bun:test';

import type { OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';

import { OAuthQuotaCapabilityUnavailableError } from '../errors';
import type { OAuthQuotaReader } from '../read';
import { createOAuthQuotaCache } from './quota-cache';

const snapshot = (id: string): OAuthQuotaSnapshot => ({ items: [{ id, displayName: id }] });

function countingReader(results: readonly (OAuthQuotaSnapshot | Error)[]): OAuthQuotaReader & { calls: () => number } {
  let index = 0;
  return {
    calls: () => index,
    read: async () => {
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      if (result instanceof Error) throw result;
      return result as OAuthQuotaSnapshot;
    },
  };
}

test('serves the cached snapshot while the provider is cooling down', async () => {
  const reader = countingReader([snapshot('a'), snapshot('b')]);
  const cache = createOAuthQuotaCache(reader);

  const first = await cache.read('p');
  const second = await cache.read('p');

  expect(reader.calls()).toBe(1);
  expect(second.snapshot).toEqual(snapshot('a'));
  expect(second.stale).toBe(false);
  expect(second.sampledAt).toBe(first.sampledAt);
});

test('an explicit refresh bypasses the cooldown', async () => {
  const reader = countingReader([snapshot('a'), snapshot('b')]);
  const cache = createOAuthQuotaCache(reader);

  await cache.read('p');
  const refreshed = await cache.read('p', true);

  expect(reader.calls()).toBe(2);
  expect(refreshed.snapshot).toEqual(snapshot('b'));
});

test('a failed refresh keeps reporting the last snapshot as stale on later cooldown hits', async () => {
  const reader = countingReader([snapshot('a'), new Error('QUOTA_READ_FAILED')]);
  const cache = createOAuthQuotaCache(reader);

  await cache.read('p');
  const stale = await cache.read('p', true);
  const cooled = await cache.read('p');

  expect(stale.snapshot).toEqual(snapshot('a'));
  expect(stale.stale).toBe(true);
  expect(stale.error).toBe('QUOTA_READ_FAILED');
  expect(cooled).toEqual(stale);
  expect(reader.calls()).toBe(2);
});

test('a first read that fails is cooled down instead of retried on every request', async () => {
  const reader = countingReader([new Error('nope')]);
  const cache = createOAuthQuotaCache(reader);

  await expect(cache.read('p')).rejects.toThrow('nope');
  await expect(cache.read('p')).rejects.toThrow('nope');

  expect(reader.calls()).toBe(1);
});

test('concurrent reads share a single upstream call', async () => {
  let calls = 0;
  const cache = createOAuthQuotaCache({
    read: async () => {
      calls += 1;
      await Bun.sleep(5);
      return snapshot('a');
    },
  });

  const [first, second] = await Promise.all([cache.read('p'), cache.read('p')]);

  expect(calls).toBe(1);
  expect(first).toEqual(second);
});

test('an unsupported provider is never retried', async () => {
  const reader = countingReader([new OAuthQuotaCapabilityUnavailableError(true)]);
  const cache = createOAuthQuotaCache(reader);

  await expect(cache.read('p')).rejects.toThrow(OAuthQuotaCapabilityUnavailableError);
  await expect(cache.read('p', true)).rejects.toThrow(OAuthQuotaCapabilityUnavailableError);
  cache.warm('p');
  await Bun.sleep(5);

  expect(reader.calls()).toBe(1);
});

test('a transient account failure wearing the unavailable error stays retryable', async () => {
  // `prepareContext` reports bad credentials, unreadable secrets, and invalid options as the same
  // opaque error as a plugin with no quota capability. Latching on it would mean one expired token
  // disables the quota ring until restart, even after the user reauthenticates.
  const reader = countingReader([new OAuthQuotaCapabilityUnavailableError(), snapshot('a')]);
  const cache = createOAuthQuotaCache(reader);

  await expect(cache.read('p')).rejects.toBeInstanceOf(OAuthQuotaCapabilityUnavailableError);

  expect((await cache.read('p', true)).snapshot).toEqual(snapshot('a'));
});

test('warm never rejects and respects the cooldown', async () => {
  createOAuthQuotaCache(countingReader([new Error('boom')])).warm('p');
  await Bun.sleep(5);

  const reader = countingReader([snapshot('a')]);
  const cooled = createOAuthQuotaCache(reader);
  cooled.warm('p');
  await Bun.sleep(5);
  cooled.warm('p');
  await Bun.sleep(5);

  expect(reader.calls()).toBe(1);
});

test('invalidation drops the snapshot, the cooldown, and the unsupported mark for a reconfigured provider', async () => {
  const reader = countingReader([snapshot('a'), snapshot('b')]);
  const cache = createOAuthQuotaCache(reader);

  await cache.read('p');
  cache.invalidate('p');
  const afterInvalidate = await cache.read('p');

  const unsupported = createOAuthQuotaCache(
    countingReader([new OAuthQuotaCapabilityUnavailableError(true), snapshot('c')]),
  );
  await expect(unsupported.read('p')).rejects.toBeInstanceOf(OAuthQuotaCapabilityUnavailableError);
  unsupported.invalidate('p');

  expect(afterInvalidate.snapshot).toEqual(snapshot('b'));
  expect(reader.calls()).toBe(2);
  expect((await unsupported.read('p')).snapshot).toEqual(snapshot('c'));
});

test('a read in flight when a provider is reconfigured does not repopulate the cache', async () => {
  let release: (value: OAuthQuotaSnapshot) => void = () => {};
  const pending = new Promise<OAuthQuotaSnapshot>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const cache = createOAuthQuotaCache({
    read: async () => {
      calls += 1;
      return calls === 1 ? await pending : snapshot('fresh');
    },
  });

  const inFlight = cache.read('p');
  cache.invalidate('p');
  release(snapshot('stale'));

  // Not just withheld from the cache: the caller must not render the retired account's snapshot
  // under the new configuration either, so the read is retried against it.
  expect((await inFlight).snapshot).toEqual(snapshot('fresh'));
  expect((await cache.read('p')).snapshot).toEqual(snapshot('fresh'));
});
