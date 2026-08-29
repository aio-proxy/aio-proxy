import { expect, test } from 'bun:test';

import { classifyProvider } from './classify';

test('classifies gemini from apiProvider regardless of case', () => {
  expect(classifyProvider({ extra: { antigravity: { apiProvider: 'GEMINI' } } })).toBe('gemini');
});

test('classifies claude when the provider string contains anthropic', () => {
  expect(classifyProvider({ extra: { antigravity: { apiProvider: 'AnthropicClaude' } } })).toBe('claude');
});

test('uses modelProvider when apiProvider is absent', () => {
  expect(classifyProvider({ extra: { antigravity: { modelProvider: 'gemini-internal' } } })).toBe('gemini');
});

test('prefers apiProvider over modelProvider', () => {
  expect(
    classifyProvider({
      extra: { antigravity: { apiProvider: 'openai', modelProvider: 'gemini' } },
    }),
  ).toBe('none');
});

test('returns none for unknown providers and missing metadata', () => {
  expect(classifyProvider({ extra: { antigravity: { apiProvider: 'openai' } } })).toBe('none');
  expect(classifyProvider({})).toBe('none');
});

test('infers claude from a migrated descriptor id when metadata is missing', () => {
  expect(classifyProvider({ id: 'claude-sonnet-4-5' })).toBe('claude');
});

test('infers gemini from a migrated descriptor id when metadata is missing', () => {
  expect(classifyProvider({ id: 'gemini-3-flash-agent' })).toBe('gemini');
});

test('keeps openai metadata over a gemini-looking id', () => {
  expect(
    classifyProvider({
      id: 'gemini-3-flash-agent',
      extra: { antigravity: { apiProvider: 'openai' } },
    }),
  ).toBe('none');
});
