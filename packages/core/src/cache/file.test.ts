import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { fileCacheStorage } from '.';

const original = process.env.AIO_PROXY_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aio-proxy-cache-'));
  process.env.AIO_PROXY_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (original === undefined) {
    delete process.env.AIO_PROXY_HOME;
  } else {
    process.env.AIO_PROXY_HOME = original;
  }
});

describe('fileCacheStorage', () => {
  test('round-trips a stored value', async () => {
    await fileCacheStorage.setItem('k', 'hello');
    expect(await fileCacheStorage.getItem<string>('k')).toBe('hello');
  });

  test('missing key returns null', async () => {
    expect(await fileCacheStorage.getItem('absent')).toBeNull();
  });

  test('expired item returns null when ttl elapsed', async () => {
    await fileCacheStorage.setItem('k', 'stale');
    // ttl in the past relative to now -> expired
    expect(await fileCacheStorage.getItem('k', { ttl: -1 })).toBeNull();
  });

  test('fresh item survives a positive ttl', async () => {
    await fileCacheStorage.setItem('k', 'fresh');
    expect(await fileCacheStorage.getItem<string>('k', { ttl: 60_000 })).toBe('fresh');
  });

  test('schema mismatch returns null', async () => {
    await fileCacheStorage.setItem('k', 'not-a-number');
    expect(await fileCacheStorage.getItem('k', { schema: z.number() })).toBeNull();
  });

  test('schema match returns parsed value', async () => {
    await fileCacheStorage.setItem('k', '42');
    expect(await fileCacheStorage.getItem('k', { schema: z.string() })).toBe('42');
  });

  test('malformed cache file returns null', async () => {
    // A stored item that does not match cacheItemSchema (missing updatedAt).
    await Bun.file(join(home, 'tmp', 'cache-storage', 'bad.json')).write(JSON.stringify({ value: 'x' }));
    expect(await fileCacheStorage.getItem('bad')).toBeNull();
  });

  test('non-JSON file content returns null instead of throwing', async () => {
    await Bun.file(join(home, 'tmp', 'cache-storage', 'raw.json')).write('not json at all');
    expect(await fileCacheStorage.getItem('raw')).toBeNull();
  });

  test('keys with path separators stay inside the cache dir', async () => {
    await fileCacheStorage.setItem('../escape', 'contained');
    // The traversal attempt round-trips as a normal key...
    expect(await fileCacheStorage.getItem<string>('../escape')).toBe('contained');
    // ...and no file leaks outside cache-storage.
    expect(await Bun.file(join(home, 'tmp', 'escape.json')).exists()).toBe(false);
  });

  test('removeItem deletes and is idempotent', async () => {
    await fileCacheStorage.setItem('k', 'gone');
    await fileCacheStorage.removeItem('k');
    expect(await fileCacheStorage.getItem('k')).toBeNull();
    // Removing an absent key must not throw.
    await fileCacheStorage.removeItem('k');
  });
});
