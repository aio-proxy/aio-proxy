import { expect, test } from 'bun:test';

import type { ModelCatalog } from '@aio-proxy/plugin-sdk';
import { type AliasConfig, resolveAliasTarget } from '@aio-proxy/types';

import { defaultCursorAliases } from './default-aliases';
import { pickDefaultModel } from './pick-default';

const catalog = (
  ids: string[],
  families: Array<{
    name: string;
    variants: Array<{ slug: string; isDefaultNonMax?: boolean }>;
  }>,
): ModelCatalog => ({
  language: ids.map((id) => ({ id })),
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
  metadata: { cursorFamilies: families },
});

const asAliasConfig = (suggestion: unknown): AliasConfig => suggestion as AliasConfig;

test('peels extra-high to xhigh and rewrites claude-4.6-sonnet', () => {
  const aliases = defaultCursorAliases(
    catalog(
      ['claude-4.6-sonnet', 'claude-4.6-sonnet-extra-high'],
      [
        {
          name: 'claude-4.6-sonnet',
          variants: [{ slug: 'claude-4.6-sonnet' }, { slug: 'claude-4.6-sonnet-extra-high' }],
        },
      ],
    ),
  );
  const row = aliases['claude-sonnet-4-6'];
  expect(row?.model).toBe('claude-4.6-sonnet');
  expect(row?.variants).toEqual([
    { when: { effort: 'xhigh' }, model: 'claude-4.6-sonnet-extra-high', preserve: false },
  ]);
});

test('ignores thinking isDefaultNonMax when a neutral slug exists', () => {
  const aliases = defaultCursorAliases(
    catalog(
      ['claude-opus-4-8-medium', 'claude-opus-4-8-thinking-high'],
      [
        {
          name: 'claude-opus-4-8',
          variants: [
            { slug: 'claude-opus-4-8-medium' },
            { slug: 'claude-opus-4-8-thinking-high', isDefaultNonMax: true },
          ],
        },
      ],
    ),
  );
  const config = asAliasConfig(aliases['claude-opus-4-8']!);
  expect(config.model).toBe('claude-opus-4-8-medium');
  expect(resolveAliasTarget(config, { thinking: false }).model).toBe('claude-opus-4-8-medium');
  expect(resolveAliasTarget(config, { thinking: true, effort: 'high' }).model).toBe('claude-opus-4-8-thinking-high');
});

test('rewrites cursor-grok and skips identity singleton', () => {
  const aliases = defaultCursorAliases(
    catalog(
      ['cursor-grok-4.6', 'gemini-3-flash'],
      [
        { name: 'cursor-grok-4.6', variants: [{ slug: 'cursor-grok-4.6' }] },
        { name: 'gemini-3-flash', variants: [{ slug: 'gemini-3-flash' }] },
      ],
    ),
  );
  expect(aliases['grok-4.6']?.model).toBe('cursor-grok-4.6');
  expect(aliases['gemini-3-flash']).toBeUndefined();
});

test('writes auto only when default is usable', () => {
  const withDefault = defaultCursorAliases(
    catalog(
      ['default', 'claude-opus-4-8-medium'],
      [{ name: 'claude-opus-4-8', variants: [{ slug: 'claude-opus-4-8-medium' }] }],
    ),
  );
  expect(withDefault.auto).toEqual({ model: 'default', preserve: false });
  const without = defaultCursorAliases(
    catalog(['claude-opus-4-8-medium'], [{ name: 'claude-opus-4-8', variants: [{ slug: 'claude-opus-4-8-medium' }] }]),
  );
  expect(without.auto).toBeUndefined();
});

test('drops variants whose slug is not usable', () => {
  const aliases = defaultCursorAliases(
    catalog(['only-usable'], [{ name: 'ghost', variants: [{ slug: 'not-usable' }] }]),
  );
  expect(aliases.ghost).toBeUndefined();
});

test('keeps the bare slug as default when the isDefaultNonMax variant is fast', () => {
  const aliases = defaultCursorAliases(
    catalog(
      ['cursor-grok-4.6', 'cursor-grok-4.6-high-fast'],
      [
        {
          name: 'cursor-grok-4.6',
          variants: [{ slug: 'cursor-grok-4.6' }, { slug: 'cursor-grok-4.6-high-fast', isDefaultNonMax: true }],
        },
      ],
    ),
  );
  const config = asAliasConfig(aliases['grok-4.6']!);
  expect(config.model).toBe('cursor-grok-4.6');
  expect(resolveAliasTarget(config, { speed: 'standard' }).model).toBe('cursor-grok-4.6');
  expect(resolveAliasTarget(config, { effort: 'high', speed: 'fast' }).model).toBe('cursor-grok-4.6-high-fast');
});

test('never picks a fast slug as default while a neutral slug exists', () => {
  const aliases = defaultCursorAliases(
    catalog(
      ['gpt-5.5-medium-fast', 'gpt-5.5-low'],
      [
        {
          name: 'gpt-5.5',
          variants: [{ slug: 'gpt-5.5-medium-fast' }, { slug: 'gpt-5.5-low' }],
        },
      ],
    ),
  );
  expect(aliases['gpt-5.5']?.model).toBe('gpt-5.5-low');
});

test('peels each axis right to left and leaves family words alone', () => {
  const aliases = defaultCursorAliases(
    catalog(
      [
        'gpt-5.4-mini',
        'gpt-5.4-mini-none',
        'gpt-5.4-mini-high-thinking',
        'gpt-5.4-mini-thinking-high-fast',
        'gpt-5.4-mini-extra-high-fast',
        'gpt-5.4-mini-turbo',
      ],
      [
        {
          name: 'gpt-5.4-mini',
          variants: [
            { slug: 'gpt-5.4-mini' },
            { slug: 'gpt-5.4-mini-none' },
            { slug: 'gpt-5.4-mini-high-thinking' },
            { slug: 'gpt-5.4-mini-thinking-high-fast' },
            { slug: 'gpt-5.4-mini-extra-high-fast' },
            { slug: 'gpt-5.4-mini-turbo' },
          ],
        },
      ],
    ),
  );
  const config = asAliasConfig(aliases['gpt-5.4-mini']!);
  expect(config.model).toBe('gpt-5.4-mini');
  expect(config.variants).toEqual([
    { when: { effort: 'none' }, model: 'gpt-5.4-mini-none', preserve: false },
    { when: { thinking: true, effort: 'high' }, model: 'gpt-5.4-mini-high-thinking', preserve: false },
    {
      when: { thinking: true, effort: 'high', speed: 'fast' },
      model: 'gpt-5.4-mini-thinking-high-fast',
      preserve: false,
    },
    { when: { effort: 'xhigh', speed: 'fast' }, model: 'gpt-5.4-mini-extra-high-fast', preserve: false },
  ]);
});

test('drops a slug that peels away entirely', () => {
  const aliases = defaultCursorAliases(
    catalog(['high', 'thinking'], [{ name: 'ghost', variants: [{ slug: 'high' }, { slug: 'thinking' }] }]),
  );
  expect(aliases.ghost).toBeUndefined();
});

test('keeps one row per when, preferring the lexicographically smaller slug', () => {
  const aliases = defaultCursorAliases(
    catalog(
      ['dup', 'dup-b-high', 'dup-a-high'],
      [
        {
          name: 'dup',
          variants: [{ slug: 'dup' }, { slug: 'dup-b-high' }, { slug: 'dup-a-high' }],
        },
      ],
    ),
  );
  expect(aliases.dup?.variants).toEqual([{ when: { effort: 'high' }, model: 'dup-a-high', preserve: false }]);
});

test('a pinned default wins over the scored pick', () => {
  const rows = [
    { slug: 'family-medium', when: { effort: 'medium' } },
    { slug: 'family-thinking-high', when: { thinking: true, effort: 'high' } },
  ];
  expect(pickDefaultModel('family', rows)).toBe('family-medium');
  expect(pickDefaultModel('family', rows, 'family-thinking-high')).toBe('family-thinking-high');
  expect(pickDefaultModel('family', rows, 'family-not-usable')).toBe('family-medium');
});
