import { describe, expect, test } from 'bun:test';

import { isObject } from './is-object';

describe('isObject', () => {
  test('accepts plain objects and class instances', () => {
    class Box {
      readonly value = 1;
    }

    expect(isObject({})).toBe(true);
    expect(isObject(Object.create(null))).toBe(true);
    expect(isObject(new Box())).toBe(true);
  });

  test('rejects null, arrays, and primitives', () => {
    expect(isObject(null)).toBe(false);
    expect(isObject([])).toBe(false);
    expect(isObject('object')).toBe(false);
    expect(isObject(1)).toBe(false);
    expect(isObject(undefined)).toBe(false);
  });
});
