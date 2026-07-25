import { readFile, writeFile } from 'node:fs/promises';

import { codexModelsCachePath } from '@aio-proxy/core';
import { zod } from '@aio-proxy/plugin-sdk';
import { type CodexUpstreamModel, CodexUpstreamModelSchema } from '@aio-proxy/types';

const CODEX_MODELS_URL = 'https://github.com/openai/codex/raw/refs/heads/main/codex-rs/models-manager/models.json';
const DEFAULT_TTL_MS = 6 * 60 * 60_000;

const CacheFileSchema = zod.object({
  fetched_at: zod.string(),
  models: zod.array(CodexUpstreamModelSchema),
});

type ReadOptions = {
  readonly now?: number;
  readonly fetchImpl?: typeof fetch;
  readonly cachePath?: string;
  readonly ttlMs?: number;
};

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
    const { models } = zod.object({ models: zod.array(CodexUpstreamModelSchema) }).parse(await response.json());
    await writeFile(cachePath, JSON.stringify({ models, fetched_at: new Date(now).toISOString() }), 'utf8');
    return models;
  } catch {
    return cached?.models ?? [];
  }
}

async function readCacheFile(
  cachePath: string,
): Promise<{ fetched_at: string; models: readonly CodexUpstreamModel[] } | undefined> {
  try {
    return CacheFileSchema.parse(JSON.parse(await readFile(cachePath, 'utf8')));
  } catch {
    return undefined;
  }
}
