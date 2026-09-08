import { describe, expect, test } from 'bun:test';

import type { ModelInvocation } from '../adapter';
import { clampSdkReasoning, modelEffortValues, normalizeEffort, reasoningSettings } from './index';

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

  test('does not trim before clamping (padded low stays off-ladder)', () => {
    expect(normalizeEffort(' low ', new Set(['low', 'medium', 'high']))).toBe('high');
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

  test('keeps a supported reasoning level and backfills the canonical effort', () => {
    const invocation = { messages: [], settings: { reasoning: 'high' as const } };
    const result = clampSdkReasoning(invocation, new Set(['low', 'medium', 'high']));
    expect(result.settings?.reasoning).toBe('high');
    expect(carriedEffort(result.settings)).toBe('high');
  });

  test('passes reasoning through when the supported set is empty', () => {
    const invocation = { messages: [], settings: { reasoning: 'xhigh' } };
    expect(clampSdkReasoning(invocation, new Set()).settings?.reasoning).toBe('xhigh');
  });
});

// `reasoningSettings` returns `T` unchanged, so the new key is not statically visible
// on the caller's type. Read it back through one narrow local helper rather than
// sprinkling casts through every assertion.
function carriedEffort(value: unknown): string | undefined {
  const providerOptions = (value as { providerOptions?: { aioProxy?: { effort?: string } } }).providerOptions;
  return providerOptions?.aioProxy?.effort;
}

function aioProxyBag(value: unknown): Record<string, unknown> | undefined {
  return (value as { providerOptions?: { aioProxy?: Record<string, unknown> } }).providerOptions?.aioProxy;
}

describe('reasoningSettings', () => {
  test('carries the canonical effort alongside the SDK representation', () => {
    const result = reasoningSettings({}, 'max');
    expect((result as { reasoning?: string }).reasoning).toBe('xhigh');
    expect(carriedEffort(result)).toBe('max');
  });

  test('folds spellings into both representations', () => {
    const result = reasoningSettings({}, 'X-High');
    expect((result as { reasoning?: string }).reasoning).toBe('xhigh');
    expect(carriedEffort(result)).toBe('xhigh');
  });

  test('returns the settings untouched when there is no effort', () => {
    const settings = { temperature: 0.5 };
    expect(reasoningSettings(settings, undefined)).toBe(settings);
  });

  test('carries an off-ladder effort canonically even when the SDK cannot express it', () => {
    const result = reasoningSettings({}, 'ultra');
    expect((result as { reasoning?: string }).reasoning).toBeUndefined();
    expect(carriedEffort(result)).toBe('ultra');
  });

  test('preserves sibling providerOptions namespaces and aioProxy keys', () => {
    const result = reasoningSettings(
      { providerOptions: { openai: { store: false }, aioProxy: { thinking: { mode: 'disabled' } } } },
      'high',
    );
    expect(result.providerOptions.openai).toEqual({ store: false });
    expect(aioProxyBag(result)).toEqual({ thinking: { mode: 'disabled' }, effort: 'high' });
  });
});

describe('clampSdkReasoning canonical effort', () => {
  // ModelInvocation['settings'] is AiSdkCallSettings, which declares no providerOptions;
  // the canonical key rides along at runtime, so build these fixtures through a cast.
  const withEffort = (reasoning: string, effort: string): ModelInvocation =>
    ({
      messages: [],
      settings: { reasoning, providerOptions: { aioProxy: { effort } } },
    }) as unknown as ModelInvocation;

  test('keeps max for a candidate that advertises max', () => {
    const result = clampSdkReasoning(withEffort('xhigh', 'max'), new Set(['low', 'medium', 'high', 'max']));
    expect(carriedEffort(result.settings)).toBe('max');
    // The SDK union has no `max`; its highest expressible level stands in.
    expect(result.settings?.reasoning).toBe('xhigh');
  });

  test('clamps max down for a candidate that stops at high', () => {
    const result = clampSdkReasoning(withEffort('xhigh', 'max'), new Set(['low', 'medium', 'high']));
    expect(carriedEffort(result.settings)).toBe('high');
    expect(result.settings?.reasoning).toBe('high');
  });

  test('falls back to settings.reasoning when no canonical effort is present', () => {
    const invocation = { messages: [], settings: { reasoning: 'xhigh' as const } };
    expect(clampSdkReasoning(invocation, new Set(['low', 'medium', 'high'])).settings?.reasoning).toBe('high');
  });

  test('is identity when the canonical effort is already supported', () => {
    const invocation = withEffort('high', 'high');
    expect(clampSdkReasoning(invocation, new Set(['low', 'medium', 'high']))).toBe(invocation);
  });

  test('passes through untouched when the supported set is empty', () => {
    const invocation = withEffort('xhigh', 'max');
    expect(clampSdkReasoning(invocation, new Set())).toBe(invocation);
  });
});
