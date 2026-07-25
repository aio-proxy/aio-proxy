import { readFile, writeFile } from 'node:fs/promises';

import { codexModelsCachePath } from '@aio-proxy/core';
import { zod } from '@aio-proxy/plugin-sdk';
import { type CodexUpstreamModel, CodexUpstreamModelSchema } from '@aio-proxy/types';

const CODEX_MODELS_URL = 'https://github.com/openai/codex/raw/refs/heads/main/codex-rs/models-manager/models.json';
const DEFAULT_TTL_MS = 6 * 60 * 60_000;

const CacheEnvelopeSchema = zod.object({
  fetched_at: zod.string(),
  models: zod.array(zod.unknown()),
});

type ReadOptions = {
  readonly now?: number;
  readonly fetchImpl?: typeof fetch;
  readonly cachePath?: string;
  readonly ttlMs?: number;
};

// A malformed row is skipped, not fatal: one bad sibling must not drop the
// whole catalog into Case B synthesis (spec: error handling).
function keepValidModels(rows: readonly unknown[]): readonly CodexUpstreamModel[] {
  return rows.flatMap((row) => {
    const parsed = CodexUpstreamModelSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

export async function readCodexModelsCache(options: ReadOptions = {}): Promise<readonly CodexUpstreamModel[]> {
  const cachePath = options.cachePath ?? codexModelsCachePath();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const now = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;

  const cached = await readCacheFile(cachePath);
  if (cached !== undefined && now - Date.parse(cached.fetched_at) < ttlMs) {
    return cached.models;
  }

  try {
    const response = await fetchImpl(CODEX_MODELS_URL);
    if (!response.ok) throw new Error(`codex models request failed with ${response.status}`);
    const { models } = zod.object({ models: zod.array(zod.unknown()) }).parse(await response.json());
    const valid = keepValidModels(models);
    await writeFile(cachePath, JSON.stringify({ models: valid, fetched_at: new Date(now).toISOString() }), 'utf8');
    return valid;
  } catch {
    return cached?.models ?? [];
  }
}

async function readCacheFile(
  cachePath: string,
): Promise<{ fetched_at: string; models: readonly CodexUpstreamModel[] } | undefined> {
  try {
    const envelope = CacheEnvelopeSchema.parse(JSON.parse(await readFile(cachePath, 'utf8')));
    return { fetched_at: envelope.fetched_at, models: keepValidModels(envelope.models) };
  } catch {
    return undefined;
  }
}
