import { expect, test } from 'bun:test';

import type { ModelCatalog, ModelDescriptor } from '@aio-proxy/plugin-sdk';

import { defaultAntigravityAliases } from './aliases';
import type { AntigravityFamily } from './collapse';
import { assembleAntigravityCatalog } from './discover';

test('emits gemini-3.8-flash for unknown split ids present in catalog and picker', () => {
  const catalog = assembleAntigravityCatalog(
    [
      descriptor('gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'),
      descriptor('gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'),
      descriptor('gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'),
    ],
    {
      agentModelSorts: [
        {
          groups: [{ modelIds: ['gemini-3.8-flash-low', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-high'] }],
        },
      ],
    },
  );
  const aliases = defaultAntigravityAliases(catalog);
  expect(aliases['gemini-3.8-flash']).toEqual({
    model: 'gemini-3.8-flash-medium',
    preserve: false,
    variants: [
      { when: { effort: 'low' }, model: 'gemini-3.8-flash-low', preserve: false },
      { when: { effort: 'medium' }, model: 'gemini-3.8-flash-medium', preserve: false },
      { when: { effort: 'high' }, model: 'gemini-3.8-flash-high', preserve: false },
      { when: { effort: 'xhigh' }, model: 'gemini-3.8-flash-high', preserve: false },
    ],
  });
  expect(aliases['gemini-3.8-flash']?.variants?.map((variant) => variant.when.effort)).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
  ]);
});

test('skips a family when any base or variant target is missing from language', () => {
  const aliases = defaultAntigravityAliases(
    catalogWithFamilies(
      ['gemini-3.8-flash-medium', 'gemini-3.8-flash-high'],
      [
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
      ],
    ),
  );
  expect(aliases).not.toHaveProperty('gemini-3.8-flash');
});

test('skips a self-referential empty-when alias', () => {
  const aliases = defaultAntigravityAliases(
    catalogWithFamilies(
      ['foo'],
      [
        {
          logicalId: 'foo',
          kind: 'same-wire',
          thinking: { mode: 'none' },
          base: 'foo',
          variants: [],
        },
      ],
    ),
  );
  expect(aliases).not.toHaveProperty('foo');
});

test('hides a discarded colliding-family wire id as a preserve-false target, not its own alias', () => {
  const aliases = defaultAntigravityAliases(
    assembleAntigravityCatalog(
      [
        descriptor('gemini-3.6-flash-low', 'Gemini 3.6 Flash (Low)'),
        descriptor('gemini-3.6-flash-medium', 'Gemini 3.6 Flash (Medium)'),
        descriptor('gemini-3.6-flash-high', 'Gemini 3.6 Flash (High)'),
        descriptor('gemini-3.6-flash-tiered', 'Gemini 3.6 Flash'),
      ],
      {
        agentModelSorts: [
          {
            groups: [
              {
                modelIds: [
                  'gemini-3.6-flash-low',
                  'gemini-3.6-flash-medium',
                  'gemini-3.6-flash-high',
                  'gemini-3.6-flash-tiered',
                ],
              },
            ],
          },
        ],
      },
    ),
  );
  expect(aliases).not.toHaveProperty('gemini-3.6-flash-tiered');
  expect(aliases['gemini-3.6-flash']?.variants).toContainEqual({
    when: { effort: 'hidden:gemini-3.6-flash-tiered' },
    model: 'gemini-3.6-flash-tiered',
    preserve: false,
  });
});

function descriptor(id: string, displayName: string): ModelDescriptor {
  return {
    id,
    displayName,
    metadata: { antigravity: { apiProvider: 'gemini' } },
  };
}

function catalogWithFamilies(ids: readonly string[], antigravityFamilies: readonly AntigravityFamily[]): ModelCatalog {
  return {
    language: ids.map((id) => ({ id })),
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
    metadata: { antigravityFamilies },
  };
}
