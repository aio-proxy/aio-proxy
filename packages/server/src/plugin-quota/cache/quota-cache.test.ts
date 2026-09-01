import { expect, test } from 'bun:test';

import type { OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';

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

const signal = () => new AbortController().signal;

test('serves the cached snapshot while the provider is cooling down', async () => {
  const reader = countingReader([snapshot('a'), snapshot('b')]);
  const cache = createOAuthQuotaCache(reader);

  const first = await cache.read('p', signal());
  const second = await cache.read('p', signal());

  expect(reader.calls()).toBe(1);
  expect(second.snapshot).toEqual(snapshot('a'));
  expect(second.stale).toBe(false);
  expect(second.sampledAt).toBe(first.sampledAt);
});

test('an explicit refresh bypasses the cooldown', async () => {
  const reader = countingReader([snapshot('a'), snapshot('b')]);
  const cache = createOAuthQuotaCache(reader);

  await cache.read('p', signal());
  const refreshed = await cache.read('p', signal(), true);

  expect(reader.calls()).toBe(2);
  expect(refreshed.snapshot).toEqual(snapshot('b'));
});

test('a failed refresh keeps the last snapshot and reports it as stale', async () => {
  const reader = countingReader([snapshot('a'), new Error('QUOTA_READ_FAILED')]);
  const cache = createOAuthQuotaCache(reader);

  await cache.read('p', signal());
  const stale = await cache.read('p', signal(), true);

  expect(stale.snapshot).toEqual(snapshot('a'));
  expect(stale.stale).toBe(true);
  expect(stale.error).toBe('QUOTA_READ_FAILED');
});

test('a first read that fails rejects instead of inventing an empty snapshot', async () => {
  const cache = createOAuthQuotaCache(countingReader([new Error('nope')]));
  await expect(cache.read('p', signal())).rejects.toThrow('nope');
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
