import { expect, test } from 'bun:test';

import { applyOverrides, mergeRaw, overlayEntityOverrides } from './local-overrides';

/**
 * Provider IDs and override segments are user data, so `__proto__` reaches these helpers. A plain
 * write there mutates `Object.prototype` instead of the projection, and a plain read hands the
 * next traversal step `Object.prototype` to write into.
 */
test('a __proto__ Provider ID stays an own property of the merged projection', () => {
  const local = JSON.parse('{"providers":{"__proto__":{"apiKey":"secret"}}}') as Record<string, never>;

  const merged = mergeRaw({ providers: {} }, local);

  const providers = merged.providers as Record<string, unknown>;
  expect(Object.hasOwn(providers, '__proto__')).toBe(true);
  expect(providers['__proto__']).toEqual({ apiKey: 'secret' });
  expect(({} as { apiKey?: string }).apiKey).toBeUndefined();
  expect(Object.getPrototypeOf(providers)).toBe(Object.prototype);
});

test('a __proto__ override segment writes into the projection, not Object.prototype', () => {
  const applied = applyOverrides({ providers: {} }, [
    { path: ['providers', '__proto__', 'apiKey'], value: 'secret' },
  ]) as { providers: Record<string, unknown> };

  expect(Object.hasOwn(applied.providers, '__proto__')).toBe(true);
  expect(applied.providers['__proto__']).toEqual({ apiKey: 'secret' });
  expect(({} as { apiKey?: string }).apiKey).toBeUndefined();
});

test('a __proto__ override does not leak an inherited value into a sibling entity', () => {
  const root: Record<string, never> = {};
  overlayEntityOverrides(root, ['providers'], [{ path: ['__proto__', 'apiKey'], value: 'secret' }]);
  overlayEntityOverrides(root, ['providers'], [{ path: ['other', 'apiKey'], value: 'plain' }]);

  const providers = root['providers'] as unknown as Record<string, unknown>;
  expect(providers['other']).toEqual({ apiKey: 'plain' });
  expect(Object.hasOwn(providers, '__proto__')).toBe(true);
  expect(({} as { apiKey?: string }).apiKey).toBeUndefined();
});
