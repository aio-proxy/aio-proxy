import { expect, test } from 'bun:test';

import { ProviderKind } from '@aio-proxy/types';

import type { ModelCapabilityIndex, RuntimeProviderInstance } from '../../../../runtime';
import { filterCandidatesByCapability } from './capability-filter';

const noPolicy = { requestedModelId: 'test-model', routerModels: undefined };
const imageOut = { capabilities: { modalities: { output: ['image' as const] } } };

test('language inbound does not keep an image-only catalog id', () => {
  const candidates = [candidate('gpt-image-2', { 'gpt-image-2': new Set(['image']) })];
  expect(filterCandidatesByCapability(candidates, 'language', noPolicy)).toEqual([]);
});

test('image inbound filters out a language-only id', () => {
  const candidates = [candidate('gpt-5', { 'gpt-5': new Set(['language']) })];
  expect(filterCandidatesByCapability(candidates, 'image', noPolicy)).toEqual([]);
});

test('embedding inbound drops an image-only catalog id', () => {
  const candidates = [candidate('gpt-image-2', { 'gpt-image-2': new Set(['image']) })];
  expect(filterCandidatesByCapability(candidates, 'embedding', noPolicy)).toEqual([]);
});

test('embedding inbound keeps an embedding catalog id', () => {
  const candidates = [candidate('embed', { embed: new Set(['embedding']) })];
  expect(filterCandidatesByCapability(candidates, 'embedding', noPolicy)).toEqual(candidates);
});

test('matching inbound capability keeps the candidate', () => {
  const language = candidate('gpt-5', { 'gpt-5': new Set(['language']) });
  const image = candidate('gpt-image-2', { 'gpt-image-2': new Set(['image']) });
  const embedding = candidate('embed', { embed: new Set(['embedding']) });
  expect(filterCandidatesByCapability([language], 'language', noPolicy)).toEqual([language]);
  expect(filterCandidatesByCapability([image], 'image', noPolicy)).toEqual([image]);
  expect(filterCandidatesByCapability([embedding], 'embedding', noPolicy)).toEqual([embedding]);
});

test('router metadata grants image per requested slug, not per shared upstream id', () => {
  // text-slug and image-slug both resolve to upstream 'wire-shared' on a
  // provider whose index has no image support. Only image-slug's policy
  // declares image output - requesting text-slug must NOT inherit it.
  const shared = candidate('wire-shared', { 'wire-shared': new Set(['language']) });
  const routerModels = {
    'image-slug': { metadata: imageOut, providers: {} },
    'text-slug': { metadata: { name: 'Text' }, providers: {} },
  };
  expect(
    filterCandidatesByCapability([shared], 'image', { requestedModelId: 'image-slug', routerModels }),
  ).toHaveLength(1);
  expect(filterCandidatesByCapability([shared], 'image', { requestedModelId: 'text-slug', routerModels })).toHaveLength(
    0,
  );
});

test('a policy keyed by a hidden upstream id does not leak through its public alias', () => {
  // 'wire' is hidden behind alias 'pretty' (non-preserve). Policy metadata on
  // the hidden slug 'wire' must not grant anything to requests for 'pretty'.
  const hidden = candidate('wire', { wire: new Set(['language']) });
  const routerModels = { wire: { metadata: imageOut, providers: {} } };
  expect(filterCandidatesByCapability([hidden], 'image', { requestedModelId: 'pretty', routerModels })).toHaveLength(0);
});

test('a provider-qualified request resolves the policy of its underlying slug', () => {
  const qualified = candidate('wire', { wire: new Set(['language']) }, 'provider_qualified');
  const routerModels = { 'image-slug': { metadata: imageOut, providers: {} } };
  expect(
    filterCandidatesByCapability([qualified], 'image', {
      requestedModelId: `${qualified.provider.id}/image-slug`,
      routerModels,
    }),
  ).toHaveLength(1);
});

test('router metadata does not grant language or embedding capability', () => {
  const languageOnly = candidate('wire', { wire: new Set(['image']) });
  const routerModels = { 'test-model': { metadata: imageOut, providers: {} } };
  expect(
    filterCandidatesByCapability([languageOnly], 'language', { requestedModelId: 'test-model', routerModels }),
  ).toEqual([]);
  expect(
    filterCandidatesByCapability([languageOnly], 'embedding', { requestedModelId: 'test-model', routerModels }),
  ).toEqual([]);
});

test('speech inbound keeps only speech-capable candidates', () => {
  // A language-only candidate reaching a speech request is the regression this
  // guards: the filter's trailing branch is `supportsLanguage`, so a missing
  // audio branch silently routes /v1/audio/speech into the chat pool.
  const speech = candidate('tts-1', { 'tts-1': new Set(['speech']) });
  const language = candidate('gpt-5', { 'gpt-5': new Set(['language']) });
  expect(filterCandidatesByCapability([speech, language], 'speech', noPolicy)).toEqual([speech]);
});

test('transcription inbound keeps only transcription-capable candidates', () => {
  const transcription = candidate('whisper-1', { 'whisper-1': new Set(['transcription']) });
  const language = candidate('gpt-5', { 'gpt-5': new Set(['language']) });
  expect(filterCandidatesByCapability([transcription, language], 'transcription', noPolicy)).toEqual([transcription]);
});

test('an audio capability does not satisfy the opposite audio direction', () => {
  // A catalog names each audio id's direction, so a TTS-only id must not answer
  // a transcription request and vice versa.
  const speech = candidate('tts-1', { 'tts-1': new Set(['speech']) });
  const transcription = candidate('whisper-1', { 'whisper-1': new Set(['transcription']) });
  expect(filterCandidatesByCapability([speech], 'transcription', noPolicy)).toEqual([]);
  expect(filterCandidatesByCapability([transcription], 'speech', noPolicy)).toEqual([]);
});

test('an attached audio transport grants the capability the index does not know about', () => {
  // A bridged `@ai-sdk/openai` provider carries the OpenAI Responses target
  // protocol, so its index grants language and embedding only - yet
  // attachAudioTransport gave it real speech/transcription transports. The SAME
  // predicate gates this filter and audio dispatch, so a candidate that passes
  // here always finds its transport rather than being skipped downstream.
  const bridged = candidate('gpt-5', { 'gpt-5': new Set(['language']) }, 'weighted_random', {
    speech: {
      invoke() {
        throw new Error('unused');
      },
    },
  });
  expect(filterCandidatesByCapability([bridged], 'speech', noPolicy)).toEqual([bridged]);
  expect(filterCandidatesByCapability([bridged], 'transcription', noPolicy)).toEqual([]);
});

function candidate(
  modelId: string,
  capabilityIndex: ModelCapabilityIndex,
  selectionSource: 'provider_qualified' | 'weighted_random' = 'weighted_random',
  transports: Partial<Pick<RuntimeProviderInstance, 'speech' | 'transcription'>> = {},
) {
  const provider: RuntimeProviderInstance = {
    id: 'provider',
    kind: ProviderKind.AiSdk,
    enabled: true,
    capabilityIndex,
    model: {
      invoke() {
        throw new Error('unused');
      },
    },
    ...transports,
  };
  return { provider, modelId, selectionSource };
}
