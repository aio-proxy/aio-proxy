import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import {
  buildModelCapabilityIndex,
  routerModelsGrantImage,
  supportsEmbedding,
  supportsImage,
  supportsLanguage,
  supportsSpeech,
  supportsTranscription,
  supportsVideo,
} from './capability-index';

// Index membership rules:
// | Source | Adds |
// | catalog.language id | language |
// | catalog.image id | image |
// | catalog.speech id | speech |
// | catalog.transcription id | transcription |
// | catalog audio/image/embedding id absent from catalog.language | never language |
// | same id in both | union |
// | upstreamMetadata capabilities.modalities.output includes image | image |
// | catalogMetadata (models.dev) output includes image AND upstream declares no output | image |
// | modalities.output present and text-only | does not add image; does not remove catalog.image |
// | primary protocol openai-image and id in finite non-catalog set (models, preserved alias targets, upstream metadata keys) | image |
// | chat primary (openai-compatible, openai-response, anthropic, gemini) and id in finite non-catalog set | language |
// | API/ai-sdk finite ids with no catalog and a chat primary | language + embedding |
// | primary protocol absent from PROTOCOL_CAPABILITIES | nothing |
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

  test('primary openai-audio marks finite non-catalog ids as speech and transcription only', () => {
    const index = buildModelCapabilityIndex({
      primaryProtocol: ProviderProtocol.OpenAIAudio,
      models: ['tts-1', 'whisper-1'],
      preservedAliasTargets: ['alias-target'],
    });
    // An audio endpoint declares no per-model direction, so both are granted and
    // the upstream rejects the mismatched one. What must never happen is the
    // audio-only provider becoming a language or embedding candidate.
    for (const id of ['tts-1', 'whisper-1', 'alias-target']) {
      expect(supportsSpeech(index, id)).toBe(true);
      expect(supportsTranscription(index, id)).toBe(true);
      expect(supportsLanguage(index, id)).toBe(false);
      expect(supportsEmbedding(index, id)).toBe(false);
      expect(supportsImage(index, id)).toBe(false);
    }
  });

  test('audio-primary with a language extra endpoint keeps finite ids chat-capable', () => {
    const index = buildModelCapabilityIndex({
      primaryProtocol: ProviderProtocol.OpenAIAudio,
      extraProtocols: [ProviderProtocol.OpenAICompatible],
      models: ['gpt-4o-audio-preview'],
    });
    expect(supportsLanguage(index, 'gpt-4o-audio-preview')).toBe(true);
    expect(supportsSpeech(index, 'gpt-4o-audio-preview')).toBe(true);
    expect(supportsTranscription(index, 'gpt-4o-audio-preview')).toBe(true);
  });

  test('chat-primary with an audio extra endpoint grants audio alongside language', () => {
    const index = buildModelCapabilityIndex({
      primaryProtocol: ProviderProtocol.OpenAICompatible,
      extraProtocols: [ProviderProtocol.OpenAIAudio],
      models: ['gpt-5'],
    });
    expect(supportsLanguage(index, 'gpt-5')).toBe(true);
    expect(supportsSpeech(index, 'gpt-5')).toBe(true);
    expect(supportsTranscription(index, 'gpt-5')).toBe(true);
  });

  test('primary openai-video marks finite ids as video only', () => {
    const index = buildModelCapabilityIndex({
      primaryProtocol: ProviderProtocol.OpenAIVideo,
      models: ['sora-2', 'sora-2-pro'],
    });
    for (const id of ['sora-2', 'sora-2-pro']) {
      expect(supportsVideo(index, id)).toBe(true);
      expect(supportsLanguage(index, id)).toBe(false);
      expect(supportsImage(index, id)).toBe(false);
    }
  });

  test('an extra openai-video endpoint grants video to every finite id', () => {
    const index = buildModelCapabilityIndex({
      primaryProtocol: ProviderProtocol.OpenAICompatible,
      models: ['sora-2', 'gpt-5'],
      extraProtocols: [ProviderProtocol.OpenAIVideo],
      upstreamMetadata: {
        'sora-2': { capabilities: { modalities: { output: ['video'] } } },
      },
    });
    expect(supportsVideo(index, 'sora-2')).toBe(true);
    expect(supportsVideo(index, 'gpt-5')).toBe(true);
    expect(supportsLanguage(index, 'gpt-5')).toBe(true);
  });

  test('text output metadata never grants video', () => {
    const index = buildModelCapabilityIndex({
      primaryProtocol: ProviderProtocol.OpenAICompatible,
      models: ['sora-2'],
      upstreamMetadata: {
        'sora-2': { capabilities: { modalities: { output: ['text'] } } },
      },
    });
    expect(supportsVideo(index, 'sora-2')).toBe(false);
  });

  test('a provider with no audio endpoint never grants speech or transcription', () => {
    const index = buildModelCapabilityIndex({
      primaryProtocol: ProviderProtocol.OpenAICompatible,
      models: ['gpt-5'],
    });
    expect(supportsSpeech(index, 'gpt-5')).toBe(false);
    expect(supportsTranscription(index, 'gpt-5')).toBe(false);
  });

  test('an audio catalog grants speech and transcription per descriptor, with no protocol', () => {
    // A plugin catalog is the only audio signal an OAuth provider has: it speaks
    // no configured wire protocol, so without catalog membership its audio models
    // would be unroutable. Unlike a protocol grant, the catalog knows the
    // direction of each id, so speech and transcription must NOT be unioned.
    const index = buildModelCapabilityIndex({
      catalog: {
        language: [],
        image: [],
        embedding: [],
        speech: [{ id: 'tts-1' }],
        transcription: [{ id: 'whisper-1' }],
        reranking: [],
      },
      models: ['tts-1', 'whisper-1'],
    });
    expect(supportsSpeech(index, 'tts-1')).toBe(true);
    expect(supportsTranscription(index, 'tts-1')).toBe(false);
    expect(supportsTranscription(index, 'whisper-1')).toBe(true);
    expect(supportsSpeech(index, 'whisper-1')).toBe(false);
  });

  test('audio catalog ids stay out of the synthesized language and embedding pools', () => {
    // `models` unions every catalog modality, so without an audio-only exclusion
    // a TTS id becomes a chat candidate and a chat request is dispatched to a
    // speech endpoint that cannot answer it.
    const index = buildModelCapabilityIndex({
      catalog: {
        language: [{ id: 'gpt-5' }],
        image: [],
        embedding: [],
        speech: [{ id: 'tts-1' }],
        transcription: [{ id: 'whisper-1' }],
        reranking: [],
      },
      models: ['gpt-5', 'tts-1', 'whisper-1'],
    });
    for (const id of ['tts-1', 'whisper-1']) {
      expect(supportsLanguage(index, id)).toBe(false);
      expect(supportsEmbedding(index, id)).toBe(false);
      expect(supportsImage(index, id)).toBe(false);
    }
    expect(supportsLanguage(index, 'gpt-5')).toBe(true);
  });

  test('a protocol absent from the capability table grants nothing at all', () => {
    // A protocol added to the enum but not to PROTOCOL_CAPABILITIES must leave
    // its ids unroutable rather than silently joining the language/embedding
    // pool, where a chat request would be dispatched to an endpoint that cannot
    // answer it. Expectations are hard-coded rather than read back from the
    // table so this fails if the table stops being the source of truth.
    const unregistered = 'unregistered-protocol' as ProviderProtocol;
    expect(buildModelCapabilityIndex({ primaryProtocol: unregistered, models: ['v1'] })).toEqual({});
    expect(
      buildModelCapabilityIndex({
        extraProtocols: [unregistered],
        models: ['v1'],
        catalog: { language: [], image: [], embedding: [] },
      }),
    ).toEqual({});
    // Nor may an unregistered extra endpoint revive language on a provider whose
    // primary protocol serves none.
    const withImagePrimary = buildModelCapabilityIndex({
      primaryProtocol: ProviderProtocol.OpenAIImage,
      extraProtocols: [unregistered],
      models: ['v1'],
    });
    expect([...withImagePrimary['v1']!]).toEqual(['image']);
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
