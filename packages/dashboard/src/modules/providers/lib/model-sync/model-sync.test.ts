import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import { toAliasRows } from '../alias-editor';
import { apiDraftFromProvider } from '../api-endpoints';
import { canRefreshSavedCatalog, manualModelsFromCatalog } from './model-sync';

test('manual mode preserves discovered hidden alias and variant targets without adding missing targets', () => {
  const alias = toAliasRows({
    fast: {
      model: 'b',
      preserve: false,
      variants: [
        { when: { effort: 'high' }, model: 'c' },
        { when: { effort: 'low' }, model: 'missing' },
      ],
    },
  });
  expect(manualModelsFromCatalog(['a', 'b', 'c'], ['b', 'c'], alias)).toEqual(['a', 'b', 'c']);
});

test('only saved synced API drafts with unchanged discovery source refresh the saved catalog', () => {
  const initial = {
    kind: ProviderKind.Api,
    id: 'p',
    syncModels: true,
    protocol: ProviderProtocol.OpenAICompatible,
    baseURL: 'https://example.com/v1',
    models: [],
  };
  const values = { ...initial, endpoints: apiDraftFromProvider(initial) };
  expect(canRefreshSavedCatalog(values, initial)).toBe(true);
  expect(canRefreshSavedCatalog({ ...values, apiKey: 'new-key', excludedModels: ['a'] }, initial)).toBe(true);
  expect(canRefreshSavedCatalog({ ...values, syncModels: undefined }, initial)).toBe(false);
  expect(canRefreshSavedCatalog(values, { ...initial, syncModels: undefined })).toBe(false);
  expect(canRefreshSavedCatalog({ ...values, protocol: ProviderProtocol.Anthropic }, initial)).toBe(false);
  expect(canRefreshSavedCatalog({ ...values, baseURL: 'https://other.example' }, initial)).toBe(false);
  expect(
    canRefreshSavedCatalog(
      {
        ...values,
        endpoints: {
          shape: 'shared',
          baseURL: 'https://other.example',
          protocols: [ProviderProtocol.OpenAICompatible],
        },
      },
      initial,
    ),
  ).toBe(false);
});

test('AI SDK catalog refresh follows the package and options base URL but ignores unrelated options', () => {
  const initial = {
    kind: ProviderKind.AiSdk,
    id: 'p',
    syncModels: true,
    packageName: '@ai-sdk/openai',
    options: { baseURL: 'https://example.com/v1' },
    models: [],
  };
  expect(canRefreshSavedCatalog({ ...initial, options: { ...initial.options, apiKey: 'new-key' } }, initial)).toBe(
    true,
  );
  expect(canRefreshSavedCatalog({ ...initial, packageName: '@ai-sdk/anthropic' }, initial)).toBe(false);
  expect(canRefreshSavedCatalog({ ...initial, options: { baseURL: 'https://other.example' } }, initial)).toBe(false);
});
