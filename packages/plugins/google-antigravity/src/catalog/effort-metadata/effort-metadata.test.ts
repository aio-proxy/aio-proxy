import { expect, test } from 'bun:test';

import type { ModelDescriptor } from '@aio-proxy/plugin-sdk';

import type { AntigravityFamily } from '../collapse';
import { withEffortMetadata } from './effort-metadata';

const claudeFamily: AntigravityFamily = {
  logicalId: 'claude-opus-4-6',
  kind: 'same-wire',
  thinking: { mode: 'claude' },
  base: 'claude-opus-4-6-thinking',
  variants: [
    { effort: 'low', model: 'claude-opus-4-6-thinking' },
    { effort: 'medium', model: 'claude-opus-4-6-thinking' },
    { effort: 'high', model: 'claude-opus-4-6-thinking' },
  ],
};

const geminiFamily: AntigravityFamily = {
  logicalId: 'gemini-3.5-flash',
  kind: 'split',
  thinking: { mode: 'gemini' },
  base: 'gemini-3.5-flash-low',
  variants: [
    { effort: 'low', model: 'gemini-3.5-flash-extra-low' },
    { effort: 'medium', model: 'gemini-3.5-flash-low' },
    { effort: 'high', model: 'gemini-3-flash-agent' },
  ],
};

function effortValues(descriptors: readonly ModelDescriptor[], id: string): readonly (string | null)[] | undefined {
  const option = descriptors
    .find((descriptor) => descriptor.id === id)
    ?.modelMetadata?.capabilities?.reasoningOptions?.find((entry) => entry.type === 'effort');
  return option?.values;
}

test('a claude wire advertises the adaptive budget ladder including max', () => {
  const result = withEffortMetadata([{ id: 'claude-opus-4-6-thinking' }], [claudeFamily]);
  expect(effortValues(result, 'claude-opus-4-6-thinking')).toEqual(['low', 'medium', 'high', 'max']);
});

test('a gemini wire advertises the gemini ladder without xhigh or max', () => {
  const result = withEffortMetadata([{ id: 'gemini-3.5-flash-low' }], [geminiFamily]);
  expect(effortValues(result, 'gemini-3.5-flash-low')).toEqual(['none', 'low', 'medium', 'high']);
});

test('only an extra-low gemini wire with a positive budget advertises minimal', () => {
  const withBudget: ModelDescriptor = {
    id: 'gemini-3.5-flash-extra-low',
    extra: { antigravity: { thinkingBudget: 1000 } },
  };
  const withoutBudget: ModelDescriptor = {
    id: 'gemini-3.5-flash-extra-low',
    extra: { antigravity: { thinkingBudget: -1 } },
  };
  expect(effortValues(withEffortMetadata([withBudget], [geminiFamily]), 'gemini-3.5-flash-extra-low')).toEqual([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
  ]);
  expect(effortValues(withEffortMetadata([withoutBudget], [geminiFamily]), 'gemini-3.5-flash-extra-low')).toEqual([
    'none',
    'low',
    'medium',
    'high',
  ]);
});

test('a non-reasoning wire advertises nothing so the host falls back to models.dev', () => {
  const result = withEffortMetadata([{ id: 'gpt-oss-120b', extra: { antigravity: { apiProvider: 'openai' } } }], []);
  expect(result[0]?.modelMetadata).toBeUndefined();
});

test('preserves every other descriptor field and existing modelMetadata', () => {
  const result = withEffortMetadata(
    [
      {
        id: 'claude-opus-4-6-thinking',
        displayName: 'Claude Opus 4.6 (Thinking)',
        extra: { antigravity: { apiProvider: 'anthropic' } },
        modelMetadata: { description: 'kept' },
      },
    ],
    [claudeFamily],
  );
  expect(result[0]?.displayName).toBe('Claude Opus 4.6 (Thinking)');
  expect(result[0]?.extra).toEqual({ antigravity: { apiProvider: 'anthropic' } });
  expect(result[0]?.modelMetadata?.description).toBe('kept');
});

test('classifies an unfamilied wire by its descriptor when no family claims it', () => {
  const result = withEffortMetadata(
    [{ id: 'claude-sonnet-4-6', extra: { antigravity: { apiProvider: 'anthropic' } } }],
    [],
  );
  expect(effortValues(result, 'claude-sonnet-4-6')).toEqual(['low', 'medium', 'high', 'max']);
});

test('a suppressed wire inherits its family mode instead of falling back to classification', () => {
  const family: AntigravityFamily = { ...geminiFamily, suppressedWireIds: ['flash-internal-7'] };
  const result = withEffortMetadata([{ id: 'flash-internal-7' }], [family]);
  expect(effortValues(result, 'flash-internal-7')).toEqual(['none', 'low', 'medium', 'high']);
});
