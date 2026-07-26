import { fileCacheStorage } from '@aio-proxy/core';
import { zod } from '@aio-proxy/plugin-sdk';
import { type CodexUpstreamModel, CodexUpstreamModelSchema } from '@aio-proxy/types';

const CODEX_MODELS_URL = 'https://github.com/openai/codex/raw/refs/heads/main/codex-rs/models-manager/models.json';
const CACHE_KEY = 'codex-models';
const DEFAULT_TTL_MS = 6 * 60 * 60_000;

// The stored value is a JSON string (fileCacheStorage.setItem only accepts a
// string); its inner shape is just the models array we downloaded.
const CacheEnvelopeSchema = zod.object({ models: zod.array(zod.unknown()) });

type ReadOptions = {
  readonly fetchImpl?: typeof fetch;
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

function readEnvelope(raw: string | null): readonly CodexUpstreamModel[] | undefined {
  if (raw === null) return undefined;
  try {
    const parsed = CacheEnvelopeSchema.safeParse(JSON.parse(raw));
    return parsed.success ? keepValidModels(parsed.data.models) : undefined;
  } catch {
    return undefined;
  }
}

export async function readCodexModelsCache(options: ReadOptions = {}): Promise<readonly CodexUpstreamModel[]> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const fresh = readEnvelope(await fileCacheStorage.getItem<string>(CACHE_KEY, { ttl: ttlMs }));
  if (fresh !== undefined) return fresh;

  try {
    const response = await fetchImpl(CODEX_MODELS_URL);
    if (!response.ok) throw new Error(`codex models request failed with ${response.status}`);
    const { models } = zod.object({ models: zod.array(zod.unknown()) }).parse(await response.json());
    const valid = keepValidModels(models);
    // Don't cache an empty result: it would read back as a fresh hit and block
    // refetching a real catalog until the TTL expires. Fall through to any stale
    // copy, else return [] so callers synthesize (Case B).
    if (valid.length === 0) return readEnvelope(await fileCacheStorage.getItem<string>(CACHE_KEY)) ?? [];
    await fileCacheStorage.setItem(CACHE_KEY, JSON.stringify({ models: valid }));
    return valid;
  } catch {
    // Download failed: fall back to the stale copy (read again without a ttl).
    return readEnvelope(await fileCacheStorage.getItem<string>(CACHE_KEY)) ?? [];
  }
}
