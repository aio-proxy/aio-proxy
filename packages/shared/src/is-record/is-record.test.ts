import { describe, expect, test } from 'bun:test';

import { isRecord } from './is-record';

describe('isRecord', () => {
  test('accepts plain objects and class instances', () => {
    class Box {
      readonly value = 1;
    }

    expect(isRecord({})).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(new Box())).toBe(true);
  });

  test('rejects null, arrays, and primitives', () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord('object')).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
  });
});
