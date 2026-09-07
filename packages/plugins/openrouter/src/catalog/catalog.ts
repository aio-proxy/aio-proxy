import type { AccountContext, ModelCatalog, ModelDescriptor } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import type { OpenRouterOAuthOptions } from '../oauth/index';
import type { OpenRouterCredential } from '../schema/index';

export const OPENROUTER_CATALOG_TTL_MS = 6 * 60 * 60_000;
const MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=text,embeddings,image';
const LANGUAGE_PROTOCOL = { protocol: 'openai-compatible' } as const;

// Frozen 2026-09-06 snapshot. Re-fetch GET /api/v1/models?sort=most-popular
// before landing; replace 404/renamed ids only. Do not invent later.
const CURATED = [
  ['openai/gpt-5.6-luna', 'OpenAI: GPT-5.6 Luna'],
  ['google/gemini-3.7-flash', 'Google: Gemini 3.7 Flash'],
  ['anthropic/claude-sonnet-5', 'Anthropic: Claude Sonnet 5'],
  ['anthropic/claude-opus-5', 'Claude Opus 5'],
  ['deepseek/deepseek-v4-pro', 'DeepSeek: DeepSeek V4 Pro 0423'],
  ['deepseek/deepseek-v4-flash', 'DeepSeek: DeepSeek V4 Flash 0423'],
  ['moonshotai/kimi-k3', 'MoonshotAI: Kimi K3'],
  ['minimax/minimax-m3', 'MiniMax: MiniMax M3'],
] as const;

export class OpenRouterCatalogError extends Error {
  override readonly name = 'OpenRouterCatalogError';

  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function discoverOpenRouterModels(
  context: AccountContext<OpenRouterCredential, Record<string, never>>,
  options: OpenRouterOAuthOptions = {},
): Promise<ModelCatalog> {
  const { value } = await context.credentials.read();
  let response: Response;
  try {
    response = await (options.fetch ?? context.fetch ?? globalThis.fetch)(MODELS_URL, {
      headers: { accept: 'application/json', authorization: `Bearer ${value.apiKey}` },
      signal: context.signal,
      aioProxy: { traffic: 'control' },
    });
  } catch {
    if (context.signal.aborted) throw context.signal.reason;
    throw new OpenRouterCatalogError('OpenRouter model discovery network failure', true);
  }
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  if (!response.ok) throw new OpenRouterCatalogError('OpenRouter model discovery rejected', retryable, response.status);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new OpenRouterCatalogError('OpenRouter model discovery returned invalid JSON', true);
  }
  if (!isPlainObject(payload) || !Array.isArray(payload.data)) {
    throw new OpenRouterCatalogError('OpenRouter model discovery returned invalid data', true);
  }

  const language: ModelDescriptor[] = [];
  const embedding: ModelDescriptor[] = [];
  const image: ModelDescriptor[] = [];
  const seen = { language: new Set<string>(), embedding: new Set<string>(), image: new Set<string>() };
  for (const entry of payload.data) {
    if (!isPlainObject(entry) || typeof entry.id !== 'string') continue;
    const id = entry.id.trim();
    if (id === '') continue;
    const displayName = typeof entry.name === 'string' && entry.name.trim() !== '' ? entry.name.trim() : undefined;
    const descriptor: ModelDescriptor = { id, ...(displayName === undefined ? {} : { displayName }) };
    const outputs = outputModalities(entry);
    if (outputs.includes('text')) pushUnique(language, seen.language, { ...descriptor, extra: LANGUAGE_PROTOCOL });
    if (outputs.includes('embeddings')) pushUnique(embedding, seen.embedding, descriptor);
    if (outputs.includes('image')) pushUnique(image, seen.image, descriptor);
  }
  return emptyCatalog(language, embedding, image);
}

export function initialOpenRouterCatalogFallback(error: unknown): ModelCatalog | undefined {
  return error instanceof OpenRouterCatalogError && error.retryable
    ? emptyCatalog(
        CURATED.map(([id, displayName]) => ({ id, displayName, extra: LANGUAGE_PROTOCOL })),
        [],
        [],
      )
    : undefined;
}

function outputModalities(entry: { readonly architecture?: unknown }): readonly string[] {
  if (!isPlainObject(entry.architecture) || !Array.isArray(entry.architecture.output_modalities)) return ['text'];
  const outputs = entry.architecture.output_modalities.filter((item): item is string => typeof item === 'string');
  return outputs.length === 0 ? ['text'] : outputs;
}

function pushUnique(list: ModelDescriptor[], seen: Set<string>, descriptor: ModelDescriptor): void {
  if (seen.has(descriptor.id)) return;
  seen.add(descriptor.id);
  list.push(descriptor);
}

function emptyCatalog(
  language: ModelCatalog['language'],
  embedding: ModelCatalog['embedding'],
  image: ModelCatalog['image'],
): ModelCatalog {
  return { language, image, embedding, speech: [], transcription: [], reranking: [] };
}
