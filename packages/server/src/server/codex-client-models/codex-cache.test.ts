import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCodexModelsCache } from './codex-cache';

const dirs: string[] = [];
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-cache-'));
  dirs.push(dir);
  return join(dir, 'codex_models_cache.json');
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const upstreamItem = {
  slug: 'gpt-5.6-sol',
  display_name: 'GPT-5.6-Sol',
  priority: 1,
  supported_in_api: true,
  visibility: 'list',
  base_instructions: 'text',
};

test('downloads and writes cache when file missing', async () => {
  const cachePath = tmpFile();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return Response.json({ models: [upstreamItem] });
  }) as unknown as typeof fetch;

  const models = await readCodexModelsCache({ cachePath, fetchImpl, now: 1000 });
  expect(models.map((m) => m.slug)).toEqual(['gpt-5.6-sol']);
  expect(calls).toBe(1);

  const again = await readCodexModelsCache({ cachePath, fetchImpl, now: 1000 });
  expect(again.map((m) => m.slug)).toEqual(['gpt-5.6-sol']);
  expect(calls).toBe(1);
});

test('returns [] when no file and download fails', async () => {
  const cachePath = tmpFile();
  const fetchImpl = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  const models = await readCodexModelsCache({ cachePath, fetchImpl });
  expect(models).toEqual([]);
});
