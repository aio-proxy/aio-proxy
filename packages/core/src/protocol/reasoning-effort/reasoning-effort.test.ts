import { describe, expect, test } from 'bun:test';

import { clampSdkReasoning, modelEffortValues, normalizeEffort, reasoningSetting } from './index';

describe('normalizeEffort', () => {
  test('passes effort through unchanged when supported set is empty', () => {
    expect(normalizeEffort('xhigh', new Set())).toBe('xhigh');
  });

  test('preserves original casing and aliases verbatim when supported set is empty', () => {
    // No capability info must be a true no-op: not even canonicalization runs,
    // so Gemini's uppercase `HIGH` (and alias forms) survive untouched.
    expect(normalizeEffort('HIGH', new Set())).toBe('HIGH');
    expect(normalizeEffort('X-High', new Set())).toBe('X-High');
  });

  test('keeps the effort when it is supported', () => {
    expect(normalizeEffort('high', new Set(['low', 'medium', 'high']))).toBe('high');
  });

  test('clamps down to the nearest supported level below the request', () => {
    expect(normalizeEffort('xhigh', new Set(['low', 'medium', 'high']))).toBe('high');
    expect(normalizeEffort('max', new Set(['low', 'medium']))).toBe('medium');
  });

  test('never raises effort above the request when nothing at or below is supported', () => {
    // Downgrade-only: asking for less than the upstream's lowest level must not
    // silently bump the request up (that would increase latency/cost).
    expect(normalizeEffort('none', new Set(['medium', 'high']))).toBe('none');
    expect(normalizeEffort('minimal', new Set(['high']))).toBe('minimal');
    // Aliases below the floor are still folded to their canonical form.
    expect(normalizeEffort('x-high', new Set(['max']))).toBe('xhigh');
  });

  test('folds aliases before clamping', () => {
    expect(normalizeEffort('x-high', new Set(['low', 'medium', 'high', 'xhigh']))).toBe('xhigh');
    expect(normalizeEffort('X_HIGH', new Set(['xhigh']))).toBe('xhigh');
    expect(normalizeEffort('extrahigh', new Set(['high']))).toBe('high');
  });

  test('passes an unknown (off-ladder) effort through when unsupported', () => {
    expect(normalizeEffort('ultra', new Set(['low', 'medium', 'high']))).toBe('high');
    expect(normalizeEffort('ultra', new Set())).toBe('ultra');
  });
});

describe('modelEffortValues', () => {
  test('reads the effort values from reasoning_options', () => {
    const model = { reasoning_options: [{ type: 'effort', values: ['low', 'high', 'xhigh'] }] };
    expect([...modelEffortValues(model)].sort()).toEqual(['high', 'low', 'xhigh']);
  });

  test('returns an empty set for a model without effort reasoning options', () => {
    expect(modelEffortValues({ reasoning_options: [{ type: 'other', values: ['x'] }] }).size).toBe(0);
    expect(modelEffortValues({}).size).toBe(0);
    expect(modelEffortValues(undefined).size).toBe(0);
    expect(modelEffortValues(null).size).toBe(0);
  });
});

describe('clampSdkReasoning', () => {
  test('clamps settings.reasoning down to a supported level', () => {
    const invocation = { messages: [], settings: { reasoning: 'xhigh' } };
    const result = clampSdkReasoning(invocation, new Set(['low', 'medium', 'high']));
    expect(result.settings?.reasoning).toBe('high');
  });

  test('returns the same invocation when reasoning is absent', () => {
    const invocation = { messages: [], settings: {} };
    expect(clampSdkReasoning(invocation, new Set(['low']))).toBe(invocation);
  });

  test('returns the same invocation when reasoning already supported', () => {
    const invocation = { messages: [], settings: { reasoning: 'high' } };
    expect(clampSdkReasoning(invocation, new Set(['low', 'medium', 'high']))).toBe(invocation);
  });

  test('passes reasoning through when the supported set is empty', () => {
    const invocation = { messages: [], settings: { reasoning: 'xhigh' } };
    expect(clampSdkReasoning(invocation, new Set()).settings?.reasoning).toBe('xhigh');
  });

  test('downgrades an out-of-union max (carried as xhigh) to a supported level', () => {
    // `max` is folded to `xhigh` by reasoningSetting before the model path, so
    // per-candidate clamping can still bring it down to what the model advertises.
    const invocation = { messages: [], settings: { reasoning: 'xhigh' } };
    expect(clampSdkReasoning(invocation, new Set(['low', 'medium', 'high'])).settings?.reasoning).toBe('high');
  });
});

describe('reasoningSetting', () => {
  test('keeps a level the AI SDK understands', () => {
    expect(reasoningSetting('high')).toEqual({ reasoning: 'high' });
    expect(reasoningSetting('xhigh')).toEqual({ reasoning: 'xhigh' });
  });

  test('folds aliases to their canonical AI SDK level instead of dropping them', () => {
    expect(reasoningSetting('x-high')).toEqual({ reasoning: 'xhigh' });
    expect(reasoningSetting('X_HIGH')).toEqual({ reasoning: 'xhigh' });
    expect(reasoningSetting('extrahigh')).toEqual({ reasoning: 'xhigh' });
  });

  test('expresses an above-ceiling ladder level (max) as xhigh so it can be clamped', () => {
    expect(reasoningSetting('max')).toEqual({ reasoning: 'xhigh' });
  });

  test('drops a genuinely unknown level and an absent value', () => {
    expect(reasoningSetting('ultra')).toEqual({});
    expect(reasoningSetting(undefined)).toEqual({});
  });
});
