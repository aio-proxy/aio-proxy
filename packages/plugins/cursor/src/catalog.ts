import type { AccountContext, ModelCatalog, ModelDescriptor } from '@aio-proxy/plugin-sdk';

import { discoverCursorModels, initialCursorCatalogFallback as discoverFallback } from './catalog/discover';
import { currentCursorCredential, type CursorOAuthDependencies } from './oauth';
import type { CursorCredential } from './schema';
import { createNodeHttp2Transport, type CursorTransport } from './wire/transport';

export const CURSOR_CATALOG_TTL_MS = 6 * 60 * 60_000;

const CURATED: ReadonlyArray<readonly [string, string]> = [
  ['claude-4.5-sonnet', 'Claude 4.5 Sonnet'],
  ['gpt-5.2-codex', 'GPT-5.2 Codex'],
  ['composer-1', 'Composer 1'],
  ['grok-code-fast-1', 'Grok Code Fast 1'],
  ['gemini-3-pro', 'Gemini 3 Pro'],
];

const emptyCatalog = (language: readonly ModelDescriptor[]): ModelCatalog => ({
  language,
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
});

export function staticCursorCatalog(): ModelCatalog {
  return emptyCatalog(CURATED.map(([id, displayName]) => ({ id, displayName })));
}

// Live discovery: refresh the credential, then hit GetUsableModels over the h2
// transport. On a retryable failure the adapter shows the curated snapshot via
// initialCursorCatalogFallback (re-exported from catalog/discover).
export async function discoverCursorCatalog(
  context: AccountContext<CursorCredential, Record<string, never>>,
  dependencies: CursorOAuthDependencies & { readonly transport?: CursorTransport } = {},
): Promise<ModelCatalog> {
  const credential = await currentCursorCredential(context.credentials, {
    ...dependencies,
    ...(dependencies.fetch === undefined && context.fetch !== undefined ? { fetch: context.fetch } : {}),
    signal: context.signal,
  });
  const transport = dependencies.transport ?? createNodeHttp2Transport();
  return await discoverCursorModels({ accessToken: credential.accessToken, transport, signal: context.signal });
}

export const initialCursorCatalogFallback = discoverFallback;
