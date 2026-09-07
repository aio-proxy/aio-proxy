import type { AccountContext, ModelCatalog, RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { CLAUDE_ANTHROPIC_VERSION, CLAUDE_MODELS_URL, CLAUDE_OAUTH_BETA, currentClaudeCredential } from '../oauth';
import type { ClaudeCredential } from '../schema';

export const CLAUDE_CATALOG_TTL_MS = 6 * 60 * 60_000;
const MAX_PAGES = 10;
const extra = { protocol: 'anthropic' } as const;
const CURATED = [
  ['claude-sonnet-5', 'Claude Sonnet 5'],
  ['claude-opus-5', 'Claude Opus 5'],
  ['claude-haiku-4-5', 'Claude Haiku 4.5'],
] as const;
const curatedNames = new Map<string, string>(CURATED);

type ClaudeCatalogOptions = {
  readonly fetch?: RuntimeFetch;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
};

type CatalogEnvelope = {
  readonly data: readonly unknown[];
  readonly nextAfterId?: string;
};

export class ClaudeCatalogError extends Error {
  override readonly name = 'ClaudeCatalogError';

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function discoverClaudeModels(
  context: AccountContext<ClaudeCredential, Record<string, never>>,
  options: ClaudeCatalogOptions = {},
): Promise<ModelCatalog> {
  const fetch = options.fetch ?? context.fetch ?? globalThis.fetch;
  const credential = await currentClaudeCredential(context.credentials, {
    ...options,
    fetch,
    signal: context.signal,
  });
  const language: Array<ModelCatalog['language'][number]> = [];
  const seen = new Set<string>();
  let afterId: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const envelope = readEnvelope(await fetchPage(fetch, credential.accessToken, afterId, context.signal));
    for (const value of envelope.data) {
      const entry = readLanguageEntry(value);
      if (entry === undefined || seen.has(entry.id)) continue;
      seen.add(entry.id);
      language.push(entry);
    }
    if (envelope.nextAfterId === undefined) return emptyCatalog(language);
    afterId = envelope.nextAfterId;
  }
  throw new ClaudeCatalogError('Claude model discovery pagination did not finish', true);
}

export function initialClaudeCatalogFallback(error: unknown): ModelCatalog | undefined {
  return error instanceof ClaudeCatalogError && error.retryable
    ? emptyCatalog(CURATED.map(([id, displayName]) => ({ id, displayName, extra })))
    : undefined;
}

async function fetchPage(
  fetch: RuntimeFetch,
  accessToken: string,
  afterId: string | undefined,
  signal: AbortSignal,
): Promise<unknown> {
  const url = new URL(CLAUDE_MODELS_URL);
  url.searchParams.set('limit', '1000');
  if (afterId !== undefined) url.searchParams.set('after_id', afterId);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${accessToken}`,
        'anthropic-beta': CLAUDE_OAUTH_BETA,
        'anthropic-version': CLAUDE_ANTHROPIC_VERSION,
      },
      aioProxy: { traffic: 'control' },
      signal,
    });
  } catch (error) {
    rethrowAbort(error, signal);
    throw new ClaudeCatalogError('Claude model discovery network failure', true);
  }
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new ClaudeCatalogError('Claude model discovery rejected', retryable, response.status);
  }
  try {
    return await response.json();
  } catch (error) {
    rethrowAbort(error, signal);
    throw new ClaudeCatalogError('Claude model discovery returned invalid JSON', true);
  }
}

function readEnvelope(payload: unknown): CatalogEnvelope {
  if (!isPlainObject(payload)) throw invalidEnvelope();
  const data = payload['data'];
  if (!Array.isArray(data)) throw invalidEnvelope();
  if (payload['has_more'] !== true) return { data };
  const lastId = payload['last_id'];
  if (typeof lastId !== 'string' || lastId === '') throw invalidEnvelope();
  return { data, nextAfterId: lastId };
}

function readLanguageEntry(value: unknown): ModelCatalog['language'][number] | undefined {
  if (!isPlainObject(value)) return undefined;
  const rawId = value['id'];
  if (typeof rawId !== 'string') return undefined;
  const id = rawId.trim();
  if (!id.startsWith('claude-')) return undefined;
  const type = value['type'];
  if (type !== undefined && type !== 'model') return undefined;
  const displayName = readDisplayName(value['display_name']) ?? curatedNames.get(id);
  return { id, ...(displayName === undefined ? {} : { displayName }), extra };
}

function readDisplayName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const displayName = value.trim();
  return displayName === '' ? undefined : displayName;
}

function emptyCatalog(language: ModelCatalog['language']): ModelCatalog {
  return { language, image: [], embedding: [], speech: [], transcription: [], reranking: [] };
}

function invalidEnvelope(): ClaudeCatalogError {
  return new ClaudeCatalogError('Claude model discovery returned invalid data', true);
}

function rethrowAbort(error: unknown, signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason;
  if (error instanceof Error && error.name === 'AbortError') throw error;
}
