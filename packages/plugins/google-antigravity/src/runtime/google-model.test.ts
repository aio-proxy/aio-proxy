import { describe, expect, test } from 'bun:test';

import { synthesizeThinking } from './google-model';

describe('synthesizeThinking', () => {
  test('prefers an explicit thinking option over both effort sources', () => {
    expect(synthesizeThinking({ mode: 'fixed', budgetTokens: 2048 }, 'max', 'high')).toEqual({
      mode: 'fixed',
      budgetTokens: 2048,
    });
  });

  test('uses the canonical effort so max survives the AI SDK ceiling', () => {
    expect(synthesizeThinking(undefined, 'max', 'xhigh')).toEqual({ mode: 'adaptive', effort: 'max' });
  });

  test('maps a canonical none onto disabled thinking', () => {
    expect(synthesizeThinking(undefined, 'none', 'none')).toEqual({ mode: 'disabled' });
  });

  test('falls back to the SDK reasoning when no canonical effort was carried', () => {
    expect(synthesizeThinking(undefined, undefined, 'high')).toEqual({ mode: 'adaptive', effort: 'high' });
    expect(synthesizeThinking(undefined, undefined, 'provider-default')).toBeUndefined();
    expect(synthesizeThinking(undefined, undefined, undefined)).toBeUndefined();
  });
});
