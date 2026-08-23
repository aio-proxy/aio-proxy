import { expect, test } from 'bun:test';

import type { ModelDescriptor } from '@aio-proxy/plugin-sdk';

import { collapseAntigravityFamilies, pickerModelIds } from './collapse';

test('collapses a live-shaped 3.5/3.6/3.7/claude/gpt-oss picker', () => {
  const families = collapseAntigravityFamilies(liveShapedInput());
  expect(families.map((family) => family.logicalId)).toEqual([
    'gemini-3.7-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.1-pro',
    'claude-sonnet-4-6',
    'claude-opus-4-6',
    'gpt-oss-120b',
  ]);
  expect(families.find((family) => family.logicalId === 'gemini-3.6-flash-tiered')).toBeUndefined();
  expect(families.find((family) => family.logicalId === 'gemini-3.1-pro')?.variants).toContainEqual({
    effort: 'high',
    model: 'gemini-pro-agent',
  });
  expect(families.find((family) => family.logicalId === 'gpt-oss-120b')?.thinking.mode).toBe('none');

  expect(families.find((family) => family.logicalId === 'gemini-3.7-flash')).toEqual({
    logicalId: 'gemini-3.7-flash',
    kind: 'tiered',
    thinking: { mode: 'gemini' },
    base: 'gemini-3.7-flash-tiered',
    variants: [
      { effort: 'low', model: 'gemini-3.7-flash-tiered' },
      { effort: 'medium', model: 'gemini-3.7-flash-tiered' },
      { effort: 'high', model: 'gemini-3.7-flash-tiered' },
    ],
  });
  expect(families.find((family) => family.logicalId === 'gemini-3.6-flash')?.kind).toBe('split');
  expect(families.find((family) => family.logicalId === 'gemini-3.6-flash')?.suppressedWireIds).toEqual([
    'gemini-3.6-flash-tiered',
  ]);
  expect(families.find((family) => family.logicalId === 'gemini-3.5-flash')?.variants).toContainEqual({
    effort: 'low',
    model: 'gemini-3.5-flash-extra-low',
  });
});

test('does not fold Extra Low displayName into low', () => {
  expect(
    collapseAntigravityFamilies({
      pickerIds: ['gemini-3.5-flash-extra-low'],
      descriptorsById: new Map([
        [
          'gemini-3.5-flash-extra-low',
          { id: 'gemini-3.5-flash-extra-low', displayName: 'Gemini 3.5 Flash (Extra Low)' },
        ],
      ]),
    }).map((family) => family.kind),
  ).toEqual(['same-wire']);
});

test('collapses unknown 3.8 split ids without a version table', () => {
  expect(
    collapseAntigravityFamilies({
      pickerIds: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high'],
      descriptorsById: new Map([
        ['gemini-3.8-flash-low', descriptor('gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)', 'gemini')],
        ['gemini-3.8-flash-medium', descriptor('gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)', 'gemini')],
        ['gemini-3.8-flash-high', descriptor('gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)', 'gemini')],
      ]),
    }),
  ).toEqual([
    {
      logicalId: 'gemini-3.8-flash',
      kind: 'split',
      thinking: { mode: 'gemini' },
      base: 'gemini-3.8-flash-medium',
      variants: [
        { effort: 'low', model: 'gemini-3.8-flash-low' },
        { effort: 'medium', model: 'gemini-3.8-flash-medium' },
        { effort: 'high', model: 'gemini-3.8-flash-high' },
      ],
    },
  ]);
});

test('keeps the earlier picker member when same-wire ids share a logicalId', () => {
  expect(
    collapseAntigravityFamilies({
      pickerIds: ['foo', 'foo-thinking'],
      descriptorsById: new Map([
        ['foo', { id: 'foo' }],
        ['foo-thinking', { id: 'foo-thinking' }],
      ]),
    }),
  ).toEqual([
    {
      logicalId: 'foo',
      kind: 'same-wire',
      thinking: { mode: 'none' },
      base: 'foo',
      variants: [
        { effort: 'low', model: 'foo' },
        { effort: 'medium', model: 'foo' },
        { effort: 'high', model: 'foo' },
      ],
      suppressedWireIds: ['foo-thinking'],
    },
  ]);
});

test('prefers gemini when family members disagree on thinking mode', () => {
  expect(
    collapseAntigravityFamilies({
      pickerIds: ['mixed-low', 'mixed-high'],
      descriptorsById: new Map([
        ['mixed-low', descriptor('mixed-low', 'Mixed (Low)', 'anthropic')],
        ['mixed-high', descriptor('mixed-high', 'Mixed (High)', 'gemini')],
      ]),
    })[0]?.thinking.mode,
  ).toBe('gemini');
});

test('slugifies a split family from a display stem when wire stems disagree', () => {
  expect(
    collapseAntigravityFamilies({
      pickerIds: ['alpha-low', 'beta-high'],
      descriptorsById: new Map([
        ['alpha-low', descriptor('alpha-low', 'Model v.2 (Low)', 'gemini')],
        ['beta-high', descriptor('beta-high', 'Model v.2 (High)', 'gemini')],
      ]),
    }),
  ).toEqual([
    {
      logicalId: 'model-v-2',
      kind: 'split',
      thinking: { mode: 'gemini' },
      base: 'alpha-low',
      variants: [
        { effort: 'low', model: 'alpha-low' },
        { effort: 'high', model: 'beta-high' },
      ],
    },
  ]);
});

test('prepends filtered flash tiered ids ahead of agentModelSorts', () => {
  expect(
    pickerModelIds({
      languageIds: new Set(['gemini-3.7-flash-tiered', 'gemini-3.6-flash-low']),
      tieredModelIds: { flash: ['absent-flash', 'gemini-3.7-flash-tiered'] },
      agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.6-flash-low', 'gemini-3.7-flash-tiered'] }] }],
    }),
  ).toEqual(['gemini-3.7-flash-tiered', 'gemini-3.6-flash-low']);
});

test('does not prepend pro or flashLite ids', () => {
  expect(
    pickerModelIds({
      languageIds: new Set(['flash-lite', 'pro-model', 'recommended']),
      tieredModelIds: { flashLite: ['flash-lite'], pro: ['pro-model'] },
      agentModelSorts: [{ groups: [{ modelIds: ['recommended'] }] }],
    }),
  ).toEqual(['recommended']);
});

function liveShapedInput(): {
  readonly pickerIds: readonly string[];
  readonly descriptorsById: ReadonlyMap<string, ModelDescriptor>;
  readonly deprecatedModelIds: Record<string, { newModelId?: string }>;
} {
  const descriptors: ModelDescriptor[] = [
    descriptor('gemini-3.7-flash-tiered', undefined, 'gemini'),
    descriptor('gemini-3.6-flash-low', 'Gemini 3.6 Flash (Low)', 'gemini'),
    descriptor('gemini-3.6-flash-medium', 'Gemini 3.6 Flash (Medium)', 'gemini'),
    descriptor('gemini-3.6-flash-high', 'Gemini 3.6 Flash (High)', 'gemini'),
    descriptor('gemini-3.6-flash-tiered', undefined, 'gemini'),
    descriptor('gemini-3.5-flash-extra-low', 'Gemini 3.5 Flash (Low)', 'gemini'),
    descriptor('gemini-3.5-flash-low', 'Gemini 3.5 Flash (Medium)', 'gemini'),
    descriptor('gemini-3-flash-agent', 'Gemini 3.5 Flash (High)', 'gemini'),
    descriptor('gemini-3.1-pro-low', 'Gemini 3.1 Pro (Low)', 'gemini'),
    descriptor('gemini-3.1-pro-high', 'Gemini 3.1 Pro (High)', 'gemini'),
    descriptor('gemini-pro-agent', 'Gemini 3.1 Pro (High)', 'gemini'),
    descriptor('claude-sonnet-4-6', 'Claude Sonnet 4.6', 'anthropic'),
    descriptor('claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)', 'anthropic'),
    descriptor('gpt-oss-120b', 'GPT-OSS 120B (Medium)', 'openai'),
    descriptor('flash-lite-model', 'Flash Lite', 'gemini'),
    descriptor('pro-only-model', 'Pro Only', 'gemini'),
  ];
  return {
    pickerIds: pickerModelIds({
      languageIds: new Set(descriptors.map((model) => model.id)),
      tieredModelIds: {
        flash: ['gemini-3.7-flash-tiered'],
        flashLite: ['flash-lite-model'],
        pro: ['pro-only-model'],
      },
      agentModelSorts: [
        {
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
    }),
    descriptorsById: new Map(descriptors.map((model) => [model.id, model])),
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
