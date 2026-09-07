import type { AccountContext, ModelCatalog } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { isRetryableStatus, MuseCodeHttpError, museControlFetch, museControlHeaders } from '../control';
import { currentMuseCodeCredential, type MuseCodeOAuthOptions } from '../oauth';
import type { MuseCodeCredential } from '../schema';

export const MUSE_CODE_CATALOG_TTL_MS = 6 * 60 * 60_000;
const MODELS_URL = 'https://api.meta.ai/v1/models';
const SPARK_PREFIX = 'muse-spark-';
const MODEL_METADATA = { protocol: 'openai-response' } as const;
const CURATED = [
  ['muse-spark-1.3', 'Muse Spark 1.3'],
  ['muse-spark-1.3-contributor', 'Muse Spark 1.3 (Contributor)'],
  ['muse-spark-1.2', 'Muse Spark 1.2'],
  ['muse-spark-1.2-contributor', 'Muse Spark 1.2 (Contributor)'],
  ['muse-spark-1.1', 'Muse Spark 1.1'],
] as const;
const curatedNames = new Map<string, string>(CURATED);

export class MuseCodeCatalogError extends Error {
  override readonly name = 'MuseCodeCatalogError';

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function discoverMuseCodeModels(
  context: AccountContext<MuseCodeCredential, Record<string, never>>,
  options: MuseCodeOAuthOptions = {},
): Promise<ModelCatalog> {
  const credential = await currentMuseCodeCredential(context.credentials, { ...options, signal: context.signal });
  const fetcher = options.fetch ?? context.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await museControlFetch(fetcher, MODELS_URL, {
      headers: museControlHeaders({ Authorization: `Bearer ${credential.apiKey}` }),
      signal: context.signal,
    });
  } catch (error) {
    if (context.signal.aborted) throw context.signal.reason;
    if (error instanceof MuseCodeHttpError) {
      throw new MuseCodeCatalogError('Muse Code model discovery network failure', error.retryable, error.status);
    }
    throw error;
  }
  if (!response.ok) {
    throw new MuseCodeCatalogError(
      'Muse Code model discovery rejected',
      isRetryableStatus(response.status),
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new MuseCodeCatalogError('Muse Code model discovery returned invalid JSON', true);
  }
  const language: ModelCatalog['language'] = [];
  const seen = new Set<string>();
  for (const value of readData(payload)) {
    if (!isPlainObject(value)) continue;
    const rawId = value.id;
    if (typeof rawId !== 'string') continue;
    const id = rawId.trim();
    if (!id.startsWith(SPARK_PREFIX) || seen.has(id)) continue;
    seen.add(id);
    const displayName = curatedNames.get(id) ?? readDisplayName(value.name) ?? readDisplayName(value.display_name);
    language.push({ id, ...(displayName === undefined ? {} : { displayName }), extra: MODEL_METADATA });
  }
  return emptyCatalog(language);
}

export function initialMuseCodeCatalogFallback(error: unknown): ModelCatalog | undefined {
  if (isAbortError(error) || !(error instanceof MuseCodeCatalogError) || !error.retryable) return undefined;
  return emptyCatalog(CURATED.map(([id, displayName]) => ({ id, displayName, extra: MODEL_METADATA })));
}

function readData(payload: unknown): readonly unknown[] {
  if (!isPlainObject(payload) || !Array.isArray(payload.data)) {
    throw new MuseCodeCatalogError('Muse Code model discovery returned invalid data', true);
  }
  return payload.data;
}

function readDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const displayName = value.trim();
  return displayName === '' ? undefined : displayName;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function emptyCatalog(language: ModelCatalog['language']): ModelCatalog {
  return { language, image: [], embedding: [], speech: [], transcription: [], reranking: [] };
}
