import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCodexModelsCache } from './codex-cache';

const CACHE_KEY = 'codex-models';
const original = process.env.AIO_PROXY_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-cache-'));
  process.env.AIO_PROXY_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (original === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = original;
});

// fileCacheStorage stores `{ value, updatedAt }`; codex-cache stores the models
// array as the JSON-string `value`. Writing the file directly lets us forge an
// old `updatedAt` to exercise the stale-fallback path.
function seedCache(models: readonly unknown[], updatedAt: string): void {
  const dir = join(home, 'tmp', 'cache-storage');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${encodeURIComponent(CACHE_KEY)}.json`),
    JSON.stringify({ value: JSON.stringify({ models }), updatedAt }),
    'utf8',
  );
}

const upstreamItem = {
  slug: 'gpt-5.6-sol',
  display_name: 'GPT-5.6-Sol',
  priority: 1,
  supported_in_api: true,
  visibility: 'list',
  base_instructions: 'text',
};

test('downloads and writes cache when file missing, then serves it fresh', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({ models: [upstreamItem] });
  }) as unknown as typeof fetch;

  const models = await readCodexModelsCache({ fetchImpl });
  expect(models.map((m) => m.slug)).toEqual(['gpt-5.6-sol']);
  expect(calls).toBe(1);

  const again = await readCodexModelsCache({ fetchImpl });
  expect(again.map((m) => m.slug)).toEqual(['gpt-5.6-sol']);
  expect(calls).toBe(1);
});

test('returns [] when no file and download fails', async () => {
  const fetchImpl = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  const models = await readCodexModelsCache({ fetchImpl });
  expect(models).toEqual([]);
});

test('skips a malformed upstream row instead of dropping the whole catalog', async () => {
  const fetchImpl = (async () =>
    Response.json({ models: [upstreamItem, { slug: '', display_name: 42 }] })) as unknown as typeof fetch;

  const models = await readCodexModelsCache({ fetchImpl });
  expect(models.map((m) => m.slug)).toEqual(['gpt-5.6-sol']);
});

test('does not cache an empty upstream result, so it refetches next time', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    // First response has no schema-valid rows; second one does.
    return calls === 1
      ? Response.json({ models: [{ slug: '', display_name: 42 }] })
      : Response.json({ models: [upstreamItem] });
  }) as unknown as typeof fetch;

  const first = await readCodexModelsCache({ fetchImpl });
  expect(first).toEqual([]);

  const second = await readCodexModelsCache({ fetchImpl });
  expect(second.map((m) => m.slug)).toEqual(['gpt-5.6-sol']);
  expect(calls).toBe(2);
});

test('returns the stale cache when it is expired and the download fails', async () => {
  seedCache([upstreamItem], new Date(0).toISOString());
  const fetchImpl = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;

  const models = await readCodexModelsCache({ fetchImpl, ttlMs: 1 });
  expect(models.map((m) => m.slug)).toEqual(['gpt-5.6-sol']);
});
