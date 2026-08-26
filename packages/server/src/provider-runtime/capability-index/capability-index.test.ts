import { describe, expect, test } from 'bun:test';

import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import type { RuntimeProviderInstance } from '../../runtime';
import {
  buildModelCapabilityIndex,
  supportsImage,
  supportsImageConvert,
  supportsImageRaw,
  supportsLanguage,
} from './capability-index';

// Index membership rules:
// | Source | Adds |
// | catalog.language id | language |
// | catalog.image id | image |
// | same id in both | union |
// | configMetadata / upstreamMetadata capabilities.modalities.output includes image | image |
// | modalities.output present and text-only | does not add image; does not remove catalog.image |
// | primary protocol openai-image and id in finite non-catalog set (models, preserved alias targets, metadata keys) | image |
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

  test('adds image from metadata modalities and does not infer from imageModel', () => {
    const index = buildModelCapabilityIndex({
      models: ['dall-e-2', 'dummy'],
      metadata: {
        'dall-e-2': { capabilities: { modalities: { output: ['image'] } } },
        dummy: {},
      },
      hasImageModel: true,
    });
    expect(supportsImage(index, 'dall-e-2')).toBe(true);
    expect(supportsImage(index, 'dummy')).toBe(false);
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
      metadata: {
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
      metadata: { 'extra-image': {} },
      preservedAliasTargets: ['alias-target'],
    });
    expect(supportsImage(index, 'gpt-image-2')).toBe(true);
    expect(supportsImage(index, 'gpt-5')).toBe(true);
    expect(supportsImage(index, 'extra-image')).toBe(true);
    expect(supportsImage(index, 'alias-target')).toBe(true);
    expect(supportsLanguage(index, 'gpt-5')).toBe(false);
    expect(supportsLanguage(index, 'gpt-image-2')).toBe(false);
  });

  test('chat-primary finite non-catalog ids support language', () => {
    const index = buildModelCapabilityIndex({
      primaryProtocol: ProviderProtocol.OpenAICompatible,
      models: ['gpt-5'],
      metadata: { 'meta-id': {} },
      preservedAliasTargets: ['alias-target'],
    });
    expect(supportsLanguage(index, 'gpt-5')).toBe(true);
    expect(supportsLanguage(index, 'meta-id')).toBe(true);
    expect(supportsLanguage(index, 'alias-target')).toBe(true);
    expect(supportsImage(index, 'gpt-5')).toBe(false);
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
      metadata: {
        'gpt-image-2': { capabilities: { modalities: { output: ['image'] } } },
      },
    });
    expect(supportsImage(index, 'gpt-image-2')).toBe(true);
    expect(supportsImage(index, 'gpt-5')).toBe(false);
    expect(supportsLanguage(index, 'gpt-5')).toBe(true);
  });
});

describe('supportsImageRaw and supportsImageConvert', () => {
  const index = buildModelCapabilityIndex({
    catalog: {
      language: [],
      image: [{ id: 'gpt-image-2' }],
      embedding: [],
      speech: [],
      transcription: [],
      reranking: [],
    },
  });

  test('supportsImageRaw requires image membership and an openai-image raw transport', () => {
    const provider = {
      id: 'images',
      kind: ProviderKind.Api,
      enabled: true,
      capabilityIndex: index,
      raw: {
        resolve: ({ protocol }: { readonly protocol: ProviderProtocol; readonly modelId: string }) =>
          protocol === ProviderProtocol.OpenAIImage ? { invoke: async () => new Response('ok') } : undefined,
      },
    } as RuntimeProviderInstance;

    expect(supportsImageRaw(provider, 'gpt-image-2')).toBe(true);
    expect(supportsImageRaw(provider, 'missing')).toBe(false);
    expect(supportsImageConvert(provider, 'gpt-image-2')).toBe(false);
  });

  test('supportsImageConvert requires image membership and an attached image transport', () => {
    const provider = {
      id: 'images',
      kind: ProviderKind.Api,
      enabled: true,
      capabilityIndex: index,
      image: {
        invoke: async () => {
          throw new Error('image transport not wired');
        },
      },
    } as RuntimeProviderInstance;

    expect(supportsImageConvert(provider, 'gpt-image-2')).toBe(true);
    expect(supportsImageConvert(provider, 'missing')).toBe(false);
    expect(supportsImageRaw(provider, 'gpt-image-2')).toBe(false);
  });
});
