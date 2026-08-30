import { expect, test } from 'bun:test';

import { isRecord } from './is-record';

test('accepts plain objects and class instances, rejects arrays and primitives', () => {
  expect(isRecord({})).toBe(true);
  expect(isRecord(Object.create(null))).toBe(true);
  expect(isRecord(new (class Box {})())).toBe(true);
  expect(isRecord([])).toBe(false);
  expect(isRecord(null)).toBe(false);
  expect(isRecord('object')).toBe(false);
});
