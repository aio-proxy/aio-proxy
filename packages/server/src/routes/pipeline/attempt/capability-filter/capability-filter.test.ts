import { expect, test } from 'bun:test';

import { ProviderKind } from '@aio-proxy/types';

import type { ModelCapabilityIndex, RuntimeProviderInstance } from '../../../../runtime';
import { filterCandidatesByCapability } from './capability-filter';

test('language inbound does not keep an image-only catalog id', () => {
  const candidates = [candidate('gpt-image-2', { 'gpt-image-2': new Set(['image']) })];
  expect(filterCandidatesByCapability(candidates, 'language')).toEqual([]);
});

test('image inbound filters out a language-only id', () => {
  const candidates = [candidate('gpt-5', { 'gpt-5': new Set(['language']) })];
  expect(filterCandidatesByCapability(candidates, 'image')).toEqual([]);
});

test('matching inbound capability keeps the candidate', () => {
  const language = candidate('gpt-5', { 'gpt-5': new Set(['language']) });
  const image = candidate('gpt-image-2', { 'gpt-image-2': new Set(['image']) });
  expect(filterCandidatesByCapability([language], 'language')).toEqual([language]);
  expect(filterCandidatesByCapability([image], 'image')).toEqual([image]);
});

function candidate(modelId: string, capabilityIndex: ModelCapabilityIndex) {
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
  };
  return { provider, modelId };
}
