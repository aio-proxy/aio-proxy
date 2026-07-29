import { fileCacheStorage } from '@aio-proxy/core';
import { zod } from '@aio-proxy/plugin-sdk';
import { type CodexUpstreamModel, CodexUpstreamModelSchema } from '@aio-proxy/types';

const CODEX_MODELS_URL = 'https://github.com/openai/codex/raw/refs/heads/main/codex-rs/models-manager/models.json';
const CACHE_KEY = 'codex-models';
const DEFAULT_TTL_MS = 6 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 3_000;

const CacheEnvelopeSchema = zod.object({ models: zod.array(zod.unknown()) });

type ReadOptions = {
  readonly fetchImpl?: typeof fetch;
  readonly ttlMs?: number;
  readonly signal?: AbortSignal;
};

// A malformed row is skipped, not fatal: one bad sibling must not drop the
// whole catalog into Case B synthesis (spec: error handling).
function keepValidModels(rows: readonly unknown[]): readonly CodexUpstreamModel[] {
  return rows.flatMap((row) => {
    const parsed = CodexUpstreamModelSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

function readEnvelope(raw: unknown): readonly CodexUpstreamModel[] | undefined {
  if (raw === null) return undefined;
  const parsed = CacheEnvelopeSchema.safeParse(raw);
  return parsed.success ? keepValidModels(parsed.data.models) : undefined;
}

// Undefined signals a failed download (network error, non-200, malformed body);
// callers then fall back to a stale copy. A bounded signal keeps a stalled
// GitHub connection from pinning the client_version request open.
async function downloadValidModels(
  fetchImpl: typeof fetch,
  signal: AbortSignal | undefined,
): Promise<readonly CodexUpstreamModel[] | undefined> {
  const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const bounded = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
  try {
    const response = await fetchImpl(CODEX_MODELS_URL, { signal: bounded });
    if (!response.ok) throw new Error(`codex models request failed with ${response.status}`);
    const { models } = CacheEnvelopeSchema.parse(await response.json());
    return keepValidModels(models);
  } catch {
    return undefined;
  }
}

// getItem rethrows non-ENOENT/SyntaxError failures (e.g. EACCES in a read-only
// container). Treat any read failure as a cache miss so the endpoint downloads
// or synthesizes instead of 500ing.
async function readCache(ttlMs?: number): Promise<unknown> {
  try {
    return await fileCacheStorage.getItem(CACHE_KEY, ttlMs === undefined ? undefined : { ttl: ttlMs });
  } catch {
    return null;
  }
}

async function staleFallback(): Promise<readonly CodexUpstreamModel[]> {
  return readEnvelope(await readCache()) ?? [];
}

export async function readCodexModelsCache(options: ReadOptions = {}): Promise<readonly CodexUpstreamModel[]> {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  const fresh = readEnvelope(await readCache(ttlMs));
  if (fresh !== undefined) return fresh;

  const valid = await downloadValidModels(fetchImpl, options.signal);
  // Download failed: fall back to the stale copy, else [] so callers synthesize.
  if (valid === undefined) return staleFallback();
  // Don't cache an empty result: it would read back as a fresh hit and block
  // refetching a real catalog until the TTL expires.
  if (valid.length === 0) return staleFallback();

  // Persisting is best-effort. A read-only dir or full disk must not discard a
  // good download and downgrade every route to synthesized Case B.
  try {
    await fileCacheStorage.setItem(CACHE_KEY, { models: valid });
  } catch {
    /* keep serving the fresh download even when the cache write fails */
  }
  return valid;
}
