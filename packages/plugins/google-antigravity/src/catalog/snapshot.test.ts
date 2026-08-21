import { expect, test } from 'bun:test';

import type { ModelDescriptor } from '@aio-proxy/plugin-sdk';

import { assembleAntigravityCatalog } from './discover';
import { staticAntigravityCatalog } from './snapshot';

test('snapshot collapse equals collapse of the same models as a live-shaped picker fixture', () => {
  const snapshot = staticAntigravityCatalog();
  expect(snapshot.language.find((model) => model.id === 'gemini-3.5-flash-extra-low')?.displayName).toBe(
    'Gemini 3.5 Flash (Low)',
  );

  const live = assembleAntigravityCatalog(liveShapedLanguage(), liveShapedPicker());
  expect(catalogField(snapshot, 'antigravityFamilies')).toEqual(catalogField(live, 'antigravityFamilies'));
  expect(catalogField(snapshot, 'antigravityPicker')).toEqual(liveShapedPicker());
});

function liveShapedLanguage(): ModelDescriptor[] {
  return [
    descriptor('gemini-3.7-flash-tiered', undefined, 'gemini'),
    descriptor('gemini-3.6-flash-low', 'Gemini 3.6 Flash (Low)', 'gemini'),
    descriptor('gemini-3.6-flash-medium', 'Gemini 3.6 Flash (Medium)', 'gemini'),
    descriptor('gemini-3.6-flash-high', 'Gemini 3.6 Flash (High)', 'gemini'),
    descriptor('gemini-3.6-flash-tiered', undefined, 'gemini'),
    descriptor('gemini-3.5-flash-extra-low', 'Gemini 3.5 Flash (Low)', 'gemini'),
    descriptor('gemini-3.5-flash-low', 'Gemini 3.5 Flash (Medium)', 'gemini'),
    descriptor('gemini-3-flash-agent', 'Gemini 3.5 Flash (High)', 'gemini'),
    descriptor('gemini-3.1-pro-low', 'Gemini 3.1 Pro (Low)', 'gemini'),
    descriptor('gemini-pro-agent', 'Gemini 3.1 Pro (High)', 'gemini'),
    descriptor('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'anthropic'),
    descriptor('claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)', 'anthropic'),
    descriptor('gpt-oss-120b', 'GPT-OSS 120B (Medium)', 'openai'),
  ];
}

function liveShapedPicker() {
  return {
    agentModelSorts: [
      {
        displayName: 'Recommended',
        groups: [
          {
            modelIds: [
              'gemini-3.6-flash-low',
              'gemini-3.6-flash-medium',
              'gemini-3.6-flash-high',
              'gemini-3.6-flash-tiered',
              'gemini-3.5-flash-extra-low',
              'gemini-3.5-flash-low',
              'gemini-3-flash-agent',
              'gemini-3.1-pro-low',
              'gemini-3.1-pro-high',
              'gemini-pro-agent',
              'claude-sonnet-4-6',
              'claude-opus-4-6-thinking',
              'gpt-oss-120b',
            ],
          },
        ],
      },
    ],
    tieredModelIds: { flash: ['gemini-3.7-flash-tiered'] },
    deprecatedModelIds: { 'gemini-3.1-pro-high': { newModelId: 'gemini-pro-agent' } },
  };
}

function descriptor(id: string, displayName: string | undefined, apiProvider: string): ModelDescriptor {
  return {
    id,
    ...(displayName === undefined ? {} : { displayName }),
    metadata: { antigravity: { apiProvider } },
  };
}

function catalogField(catalog: ReturnType<typeof staticAntigravityCatalog>, key: string): unknown {
  const metadata = catalog.metadata;
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return undefined;
  return metadata[key];
}
