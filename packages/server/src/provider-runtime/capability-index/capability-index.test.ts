import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import {
  buildModelCapabilityIndex,
  routerModelsGrantImage,
  supportsEmbedding,
  supportsImage,
  supportsLanguage,
} from './capability-index';

// Index membership rules:
// | Source | Adds |
// | catalog.language id | language |
// | catalog.image id | image |
// | same id in both | union |
// | upstreamMetadata capabilities.modalities.output includes image | image |
// | catalogMetadata (models.dev) output includes image AND upstream declares no output | image |
// | modalities.output present and text-only | does not add image; does not remove catalog.image |
// | primary protocol openai-image and id in finite non-catalog set (models, preserved alias targets, upstream metadata keys) | image |
// | chat primary (openai-compatible, openai-response, anthropic, gemini) and id in finite non-catalog set | language |
// | API/ai-sdk finite ids with no catalog and a non-openai-image primary | language |
// | V4 imageModel function exists | never |

describe('buildModelCapabilityIndex', () => {
  test('unions catalog language and image membership', () => {
    const index = buildModelCapabilityIndex({
      catalog: {
        language: [{ id: 'gpt-5' }, { id: 'shared' }],
        image: [{ id: 'gpt-image-2' }, { id: 'shared' }],
        embedding: [],
        speech: [],
        transcription: [],
        reranking: [],
      },
      models: ['shared'],
    });
    expect([...index['gpt-5']!]).toEqual(['language']);
    expect([...index['gpt-image-2']!]).toEqual(['image']);
    expect(new Set(index['shared']!)).toEqual(new Set(['language', 'image']));
  });

  test('catalog embedding membership does not mark image-only ids as embedding', () => {
    const index = buildModelCapabilityIndex({
      catalog: {
        language: [{ id: 'chat' }],
        image: [{ id: 'gpt-image-2' }, { id: 'shared' }],
        embedding: [{ id: 'embed' }, { id: 'shared' }],
        speech: [],
        transcription: [],
        reranking: [],
      },
      models: ['gpt-image-2', 'embed', 'shared'],
    });
    expect(supportsEmbedding(index, 'embed')).toBe(true);
    expect(supportsEmbedding(index, 'shared')).toBe(true);
    expect(supportsEmbedding(index, 'gpt-image-2')).toBe(false);
    expect(supportsImage(index, 'gpt-image-2')).toBe(true);
  });

  test('adds image from upstream metadata modalities and does not infer from imageModel', () => {
    const index = buildModelCapabilityIndex({
      models: ['dall-e-2', 'dummy'],
      upstreamMetadata: {
        'dall-e-2': { capabilities: { modalities: { output: ['image'] } } },
        dummy: {},
      },
      hasImageModel: true,
    });
    expect(supportsImage(index, 'dall-e-2')).toBe(true);
    expect(supportsImage(index, 'dummy')).toBe(false);
  });

  test('models.dev catalog metadata grants image only when upstream declares no output modality', () => {
    const index = buildModelCapabilityIndex({
      primaryProtocol: ProviderProtocol.OpenAIResponse,
      models: ['gpt-image-2', 'gpt-5', 'upstream-text'],
      upstreamMetadata: { 'upstream-text': { capabilities: { modalities: { output: ['text'] } } } },
      catalogMetadata: {
        'gpt-image-2': { capabilities: { modalities: { output: ['image'] } } },
        'gpt-5': { capabilities: { modalities: { output: ['text'] } } },
        'upstream-text': { capabilities: { modalities: { output: ['image'] } } },
        'not-configured': { capabilities: { modalities: { output: ['image'] } } },
      },
    });
    expect(supportsImage(index, 'gpt-image-2')).toBe(true);
    expect(supportsImage(index, 'gpt-5')).toBe(false);
    // Upstream outranks the catalog beneath it, even when the catalog says image.
    expect(supportsImage(index, 'upstream-text')).toBe(false);
    // The catalog answers "does this produce images?", never "is this routable?".
    expect(index['not-configured']).toBeUndefined();
  });

  test('text-only modalities do not add image and do not remove catalog.image', () => {
    const index = buildModelCapabilityIndex({
      catalog: {
        language: [],
        image: [{ id: 'catalog-image' }],
        embedding: [],
        speech: [],
        transcription: [],
        reranking: [],
      },
      upstreamMetadata: {
        'catalog-image': { capabilities: { modalities: { output: ['text'] } } },
        'gpt-5': { capabilities: { modalities: { output: ['text'] } } },
      },
      models: ['gpt-5'],
    });
    expect(supportsImage(index, 'catalog-image')).toBe(true);
    expect(supportsImage(index, 'gpt-5')).toBe(false);
    expect(supportsLanguage(index, 'gpt-5')).toBe(false);
  });

  test('primary openai-image marks finite non-catalog ids as image', () => {
    const index = buildModelCapabilityIndex({
      primaryProtocol: ProviderProtocol.OpenAIImage,
      models: ['gpt-image-2', 'gpt-5'],
      upstreamMetadata: { 'extra-image': {} },
      preservedAliasTargets: ['alias-target'],
    });
    expect(supportsImage(index, 'gpt-image-2')).toBe(true);
    expect(supportsImage(index, 'gpt-5')).toBe(true);
    expect(supportsImage(index, 'extra-image')).toBe(true);
    expect(supportsImage(index, 'alias-target')).toBe(true);
    expect(supportsLanguage(index, 'gpt-5')).toBe(false);
    expect(supportsLanguage(index, 'gpt-image-2')).toBe(false);
  });

  test('image-primary extra language protocol keeps finite ids chat-capable', () => {
    const index = buildModelCapabilityIndex({
      primaryProtocol: ProviderProtocol.OpenAIImage,
      extraProtocols: [ProviderProtocol.OpenAICompatible],
      models: ['gpt-5', 'gpt-image-2'],
      catalog: {
        language: [],
        image: [{ id: 'catalog-image-only' }],
        embedding: [],
        speech: [],
        transcription: [],
        reranking: [],
      },
    });
    expect(supportsLanguage(index, 'gpt-5')).toBe(true);
    expect(supportsImage(index, 'gpt-5')).toBe(true);
    expect(supportsLanguage(index, 'gpt-image-2')).toBe(true);
    expect(supportsLanguage(index, 'catalog-image-only')).toBe(false);
    expect(supportsImage(index, 'catalog-image-only')).toBe(true);
  });

  test('chat-primary finite non-catalog ids support language', () => {
    const index = buildModelCapabilityIndex({
      primaryProtocol: ProviderProtocol.OpenAICompatible,
      models: ['gpt-5'],
      upstreamMetadata: { 'meta-id': {} },
      preservedAliasTargets: ['alias-target'],
    });
    expect(supportsLanguage(index, 'gpt-5')).toBe(true);
    expect(supportsLanguage(index, 'meta-id')).toBe(true);
    expect(supportsLanguage(index, 'alias-target')).toBe(true);
    expect(supportsImage(index, 'gpt-5')).toBe(false);
  });

  test('does not synthesize language for catalog-image-only ids when models unions them', () => {
    const index = buildModelCapabilityIndex({
      catalog: {
        language: [{ id: 'gpt-5' }],
        image: [{ id: 'gpt-image-2' }],
        embedding: [],
        speech: [],
        transcription: [],
        reranking: [],
      },
      models: ['gpt-5', 'gpt-image-2'],
    });
    expect([...index['gpt-5']!]).toEqual(['language']);
    expect([...index['gpt-image-2']!]).toEqual(['image']);
  });

  test('does not synthesize language for catalog-embedding-only ids when models unions them', () => {
    const index = buildModelCapabilityIndex({
      catalog: {
        language: [{ id: 'gpt-5' }],
        image: [],
        embedding: [{ id: 'text-embedding-3-small' }],
        speech: [],
        transcription: [],
        reranking: [],
      },
      models: ['gpt-5', 'text-embedding-3-small'],
    });
    expect([...index['gpt-5']!]).toEqual(['language']);
    expect([...index['text-embedding-3-small']!]).toEqual(['embedding']);
    expect(supportsLanguage(index, 'text-embedding-3-small')).toBe(false);
  });

  test('keeps alias targets language-capable after a language catalog drops them', () => {
    const index = buildModelCapabilityIndex({
      catalog: {
        language: [{ id: 'replacement' }],
        image: [],
        embedding: [],
        speech: [],
        transcription: [],
        reranking: [],
      },
      aliasTargets: ['removed-from-catalog'],
    });
    expect(supportsLanguage(index, 'removed-from-catalog')).toBe(true);
    expect(supportsLanguage(index, 'replacement')).toBe(true);
  });

  test('seeds non-preserving alias targets as language on a chat primary', () => {
    const index = buildModelCapabilityIndex({
      primaryProtocol: ProviderProtocol.OpenAICompatible,
      aliasTargets: ['gpt-4o-mini'],
    });
    expect(supportsLanguage(index, 'gpt-4o-mini')).toBe(true);
    expect(supportsImage(index, 'gpt-4o-mini')).toBe(false);
  });

  test('openai-image endpoint on a chat-primary provider does not mark every models id as image', () => {
    const index = buildModelCapabilityIndex({
      primaryProtocol: ProviderProtocol.OpenAICompatible,
      extraProtocols: [ProviderProtocol.OpenAIImage],
      models: ['gpt-5', 'gpt-image-2'],
      upstreamMetadata: {
        'gpt-image-2': { capabilities: { modalities: { output: ['image'] } } },
      },
    });
    expect(supportsImage(index, 'gpt-image-2')).toBe(true);
    expect(supportsImage(index, 'gpt-5')).toBe(false);
    expect(supportsLanguage(index, 'gpt-5')).toBe(true);
  });
});

describe('routerModelsGrantImage', () => {
  test('detects an image-output policy anywhere in the router models', () => {
    expect(routerModelsGrantImage(undefined)).toBe(false);
    expect(routerModelsGrantImage({ pub: { metadata: { name: 'Text' }, providers: {} } })).toBe(false);
    expect(
      routerModelsGrantImage({
        text: { providers: {} },
        pub: { metadata: { capabilities: { modalities: { output: ['image'] } } }, providers: {} },
      }),
    ).toBe(true);
  });
});
