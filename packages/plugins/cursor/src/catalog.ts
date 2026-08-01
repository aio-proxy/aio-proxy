import type { ModelCatalog, ModelDescriptor } from '@aio-proxy/plugin-sdk';

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

export function initialCursorCatalogFallback(_error: unknown): ModelCatalog | undefined {
  return undefined;
}
