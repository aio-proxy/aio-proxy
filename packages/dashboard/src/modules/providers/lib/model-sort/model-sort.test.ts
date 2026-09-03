import { expect, test } from '@rstest/core';

import { sortModelIds } from './model-sort';

test('families group together and their newest version leads', () => {
  expect(sortModelIds(['gpt-5-mini', 'gemini-3-flash', 'gpt-5.6-sol', 'gemini-3.7-flash', 'gpt-5.5'])).toEqual([
    'gemini-3.7-flash',
    'gemini-3-flash',
    'gpt-5.6-sol',
    'gpt-5.5',
    'gpt-5-mini',
  ]);
});

// The version run is compared as a number, so `4.10` must outrank `4.6` rather than losing a
// string comparison on the second character.
test('version numbers compare numerically, not character by character', () => {
  expect(sortModelIds(['grok-4.6', 'grok-4.10', 'grok-4.5'])).toEqual(['grok-4.10', 'grok-4.6', 'grok-4.5']);
});

test('a bare version leads its own qualified variants', () => {
  expect(sortModelIds(['claude-opus-5-thinking', 'claude-opus-5', 'claude-opus-4-8'])).toEqual([
    'claude-opus-5',
    'claude-opus-5-thinking',
    'claude-opus-4-8',
  ]);
});

test('names without numbers stay in dictionary order', () => {
  expect(sortModelIds(['kimi-latest', 'composer', 'kimi-code'])).toEqual(['composer', 'kimi-code', 'kimi-latest']);
});

test('sorting leaves the caller array untouched', () => {
  const models = ['b-2', 'a-1'];
  sortModelIds(models);
  expect(models).toEqual(['b-2', 'a-1']);
});

// A real Provider's catalog, the case this ordering exists for: every family is contiguous and each
// one's newest release leads it.
test('a mixed multi-vendor catalog groups by family, newest first', () => {
  expect(
    sortModelIds([
      'gemini-3-flash',
      'gpt-5-mini',
      'grok-4.6',
      'gpt-5.6-sol',
      'gemini-3.7-flash',
      'grok-4',
      'gpt-5',
      'gemini-2.5-pro',
    ]),
  ).toEqual([
    'gemini-3.7-flash',
    'gemini-3-flash',
    'gemini-2.5-pro',
    'gpt-5.6-sol',
    'gpt-5',
    'gpt-5-mini',
    'grok-4.6',
    'grok-4',
  ]);
});
