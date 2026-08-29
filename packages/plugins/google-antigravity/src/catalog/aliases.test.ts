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

test('skips a same-wire identity alias whose effort rows all target the same model', () => {
  const aliases = defaultAntigravityAliases(
    catalogWithFamilies(
      ['claude-sonnet-4-6'],
      [
        {
          logicalId: 'claude-sonnet-4-6',
          kind: 'same-wire',
          thinking: { mode: 'claude' },
          base: 'claude-sonnet-4-6',
          variants: [
            { effort: 'low', model: 'claude-sonnet-4-6' },
            { effort: 'medium', model: 'claude-sonnet-4-6' },
            { effort: 'high', model: 'claude-sonnet-4-6' },
          ],
        },
      ],
    ),
  );
  expect(aliases).not.toHaveProperty('claude-sonnet-4-6');
});

test('keeps a rename-only alias when every effort row targets the same wire model', () => {
  const aliases = defaultAntigravityAliases(
    catalogWithFamilies(
      ['claude-opus-4-6-thinking'],
      [
        {
          logicalId: 'claude-opus-4-6',
          kind: 'same-wire',
          thinking: { mode: 'claude' },
          base: 'claude-opus-4-6-thinking',
          variants: [
            { effort: 'low', model: 'claude-opus-4-6-thinking' },
            { effort: 'medium', model: 'claude-opus-4-6-thinking' },
            { effort: 'high', model: 'claude-opus-4-6-thinking' },
          ],
        },
      ],
    ),
  );
  expect(aliases['claude-opus-4-6']).toEqual({
    model: 'claude-opus-4-6-thinking',
    preserve: false,
  });
});

test('does not hide gemini-3.7-flash-tiered when that wire is the family itself', () => {
  const aliases = defaultAntigravityAliases(
    assembleAntigravityCatalog([descriptor('gemini-3.7-flash-tiered', 'Gemini 3.7 Flash')], {
      agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.7-flash-tiered'] }] }],
      tieredModelIds: { flash: ['gemini-3.7-flash-tiered'] },
    }),
  );
  expect(aliases['gemini-3.7-flash']).toEqual({
    model: 'gemini-3.7-flash-tiered',
    preserve: false,
  });
  expect(aliases['gemini-3.7-flash']?.variants).toBeUndefined();
});

test('defaults a split-plus-tiered family to the tiered wire and maps xhigh there', () => {
  const aliases = defaultAntigravityAliases(
    assembleAntigravityCatalog(
      [
        descriptor('gemini-3.7-flash-low', 'Gemini 3.7 Flash (Low)'),
        descriptor('gemini-3.7-flash-medium', 'Gemini 3.7 Flash (Medium)'),
        descriptor('gemini-3.7-flash-high', 'Gemini 3.7 Flash (High)'),
        descriptor('gemini-3.7-flash-tiered', 'Gemini 3.7 Flash'),
      ],
      {
        agentModelSorts: [
          {
            groups: [
              {
                modelIds: [
                  'gemini-3.7-flash-low',
                  'gemini-3.7-flash-medium',
                  'gemini-3.7-flash-high',
                  'gemini-3.7-flash-tiered',
                ],
              },
            ],
          },
        ],
        tieredModelIds: { flash: ['gemini-3.7-flash-tiered'] },
      },
    ),
  );
  expect(aliases).not.toHaveProperty('gemini-3.7-flash-tiered');
  expect(aliases['gemini-3.7-flash']).toEqual({
    model: 'gemini-3.7-flash-tiered',
    preserve: false,
    variants: [
      { when: { effort: 'low' }, model: 'gemini-3.7-flash-low', preserve: false },
      { when: { effort: 'medium' }, model: 'gemini-3.7-flash-medium', preserve: false },
      { when: { effort: 'high' }, model: 'gemini-3.7-flash-high', preserve: false },
      { when: { effort: 'xhigh' }, model: 'gemini-3.7-flash-tiered', preserve: false },
    ],
  });
});

test('keeps a lone high row when the default is the catalog tiered sibling', () => {
  const aliases = defaultAntigravityAliases(
    catalogWithFamilies(
      ['foo-high', 'foo-tiered'],
      [
        {
          logicalId: 'foo',
          kind: 'split',
          thinking: { mode: 'gemini' },
          base: 'foo-high',
          variants: [{ effort: 'high', model: 'foo-high' }],
        },
      ],
    ),
  );
  expect(aliases['foo']).toEqual({
    model: 'foo-tiered',
    preserve: false,
    variants: [
      { when: { effort: 'high' }, model: 'foo-high', preserve: false },
      { when: { effort: 'xhigh' }, model: 'foo-tiered', preserve: false },
    ],
  });
});

test('defaults gemini-3.6-flash to its catalog tiered sibling even when the picker omits it', () => {
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
                modelIds: ['gemini-3.6-flash-low', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-high'],
              },
            ],
          },
        ],
        tieredModelIds: { flash: ['gemini-3.7-flash-tiered'] },
      },
    ),
  );
  expect(aliases).not.toHaveProperty('gemini-3.6-flash-tiered');
  expect(aliases['gemini-3.6-flash']).toEqual({
    model: 'gemini-3.6-flash-tiered',
    preserve: false,
    variants: [
      { when: { effort: 'low' }, model: 'gemini-3.6-flash-low', preserve: false },
      { when: { effort: 'medium' }, model: 'gemini-3.6-flash-medium', preserve: false },
      { when: { effort: 'high' }, model: 'gemini-3.6-flash-high', preserve: false },
      { when: { effort: 'xhigh' }, model: 'gemini-3.6-flash-tiered', preserve: false },
    ],
  });
});

test('maps a same-wire thinking sibling onto when.thinking even when the picker omits both ids', () => {
  const aliases = defaultAntigravityAliases(
    assembleAntigravityCatalog(
      [
        descriptor('gemini-2.5-flash', 'Gemini 2.5 Flash'),
        descriptor('gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite'),
        descriptor('gemini-2.5-flash-thinking', 'Gemini 2.5 Flash (Thinking)'),
      ],
      {
        agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.7-flash-high'] }] }],
      },
    ),
  );
  expect(aliases).not.toHaveProperty('gemini-2.5-flash-thinking');
  expect(aliases).not.toHaveProperty('gemini-2.5-flash-lite');
  expect(aliases['gemini-2.5-flash']).toEqual({
    model: 'gemini-2.5-flash',
    preserve: false,
    variants: [{ when: { thinking: true }, model: 'gemini-2.5-flash-thinking', preserve: false }],
  });
});

test('rebuilds leftover thinking siblings from language when stored families omit them', () => {
  const aliases = defaultAntigravityAliases({
    language: [
      descriptor('gemini-2.5-flash', 'Gemini 2.5 Flash'),
      descriptor('gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite'),
      descriptor('gemini-2.5-flash-thinking', 'Gemini 2.5 Flash (Thinking)'),
      descriptor('gemini-3.7-flash-high', 'Gemini 3.7 Flash (High)'),
    ],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
    extra: {
      antigravityPicker: {
        agentModelSorts: [{ groups: [{ modelIds: ['gemini-3.7-flash-high'] }] }],
      },
      antigravityFamilies: [
        {
          logicalId: 'gemini-3.7-flash',
          kind: 'split',
          thinking: { mode: 'gemini' },
          base: 'gemini-3.7-flash-high',
          variants: [{ effort: 'high', model: 'gemini-3.7-flash-high' }],
        },
      ],
    },
  });
  expect(aliases).not.toHaveProperty('gemini-2.5-flash-thinking');
  expect(aliases['gemini-2.5-flash']).toEqual({
    model: 'gemini-2.5-flash',
    preserve: false,
    variants: [{ when: { thinking: true }, model: 'gemini-2.5-flash-thinking', preserve: false }],
  });
});

test('attaches a leftover thinking sibling onto an already-stored identity family', () => {
  const aliases = defaultAntigravityAliases({
    language: [descriptor('foo', 'Foo'), descriptor('foo-thinking', 'Foo (Thinking)')],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
    extra: {
      antigravityFamilies: [
        {
          logicalId: 'foo',
          kind: 'same-wire',
          thinking: { mode: 'none' },
          base: 'foo',
          variants: [],
        },
      ],
    },
  });
  expect(aliases).not.toHaveProperty('foo-thinking');
  expect(aliases['foo']).toEqual({
    model: 'foo',
    preserve: false,
    variants: [{ when: { thinking: true }, model: 'foo-thinking', preserve: false }],
  });
});

test('hides a discarded non-thinking colliding wire id as a preserve-false target, not its own alias', () => {
  const aliases = defaultAntigravityAliases(
    catalogWithFamilies(
      ['foo', 'foo-extra'],
      [
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
          suppressedWireIds: ['foo-extra'],
        },
      ],
    ),
  );
  expect(aliases).not.toHaveProperty('foo-extra');
  expect(aliases['foo']).toEqual({
    model: 'foo',
    preserve: false,
    variants: [{ when: { effort: 'hidden:foo-extra' }, model: 'foo-extra', preserve: false }],
  });
});

function descriptor(id: string, displayName: string): ModelDescriptor {
  return {
    id,
    displayName,
    extra: { antigravity: { apiProvider: 'gemini' } },
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
    extra: { antigravityFamilies },
  };
}
