import { describe, expect, test } from 'bun:test';

import { clampSdkReasoning, modelEffortValues, normalizeEffort } from './index';

describe('normalizeEffort', () => {
  test('passes effort through unchanged when supported set is empty', () => {
    expect(normalizeEffort('xhigh', new Set())).toBe('xhigh');
  });

  test('keeps the effort when it is supported', () => {
    expect(normalizeEffort('high', new Set(['low', 'medium', 'high']))).toBe('high');
  });

  test('clamps down to the nearest supported level below the request', () => {
    expect(normalizeEffort('xhigh', new Set(['low', 'medium', 'high']))).toBe('high');
    expect(normalizeEffort('max', new Set(['low', 'medium']))).toBe('medium');
  });

  test('clamps down to the lowest supported level when nothing below the request exists', () => {
    expect(normalizeEffort('none', new Set(['medium', 'high']))).toBe('medium');
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
});
