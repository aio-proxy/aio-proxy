import { describe, expect, test } from 'bun:test';

import type { CredentialPort, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import type { OpenRouterCredential } from '../schema/index';
import { discoverOpenRouterModels, initialOpenRouterCatalogFallback, OpenRouterCatalogError } from './catalog';

const MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=text,embeddings,image';

describe('OpenRouter model catalog', () => {
  test('classifies language, embedding, and image models and defaults protocol', async () => {
    const inits: RuntimeRequestInit[] = [];
    let url = '';
    const catalog = await discoverOpenRouterModels(context(), {
      fetch: async (input, init) => {
        url = String(input);
        inits.push(init ?? {});
        return Response.json({
          data: [
            { id: 'openai/gpt-5.6-luna', name: 'OpenAI: GPT-5.6 Luna' },
            {
              id: 'google/gemini-embed',
              name: 'Gemini Embed',
              architecture: { output_modalities: ['embeddings'] },
            },
            {
              id: 'black-forest/flux',
              name: 'Flux',
              architecture: { output_modalities: ['image'] },
            },
            { id: '   ' },
            { name: 'missing-id' },
          ],
        });
      },
    });
    expect(url).toBe(MODELS_URL);
    expect(inits[0]?.aioProxy).toEqual({ traffic: 'control' });
    expect(catalog.language).toEqual([
      {
        id: 'openai/gpt-5.6-luna',
        displayName: 'OpenAI: GPT-5.6 Luna',
        extra: { protocol: 'openai-compatible' },
      },
    ]);
    expect(catalog.embedding).toEqual([{ id: 'google/gemini-embed', displayName: 'Gemini Embed' }]);
    expect(catalog.image).toEqual([{ id: 'black-forest/flux', displayName: 'Flux' }]);
  });

  test('falls back only for retryable discovery failures', () => {
    const fallback = initialOpenRouterCatalogFallback(new OpenRouterCatalogError('network', true));
    expect(fallback?.language).toContainEqual({
      id: 'anthropic/claude-sonnet-5',
      displayName: 'Anthropic: Claude Sonnet 5',
      extra: { protocol: 'openai-compatible' },
    });
    expect(initialOpenRouterCatalogFallback(new OpenRouterCatalogError('unauthorized', false, 401))).toBeUndefined();
  });

  test('treats a successful empty language catalog as authoritative', async () => {
    const catalog = await discoverOpenRouterModels(context(), {
      fetch: async () => Response.json({ data: [] }),
    });
    expect(catalog.language).toEqual([]);
    expect(initialOpenRouterCatalogFallback(new OpenRouterCatalogError('empty', false))).toBeUndefined();
  });
});

function context() {
  return {
    credentials: staticPort(),
    options: {},
    signal: new AbortController().signal,
  };
}

function staticPort(): CredentialPort<OpenRouterCredential> {
  return {
    read: async () => ({ revision: 1, value: { apiKey: 'sk-or-v1-test-key' } }),
    refresh: async () => {
      throw new Error('durable OpenRouter keys must not refresh');
    },
  };
}
