import { describe, expect, test } from 'bun:test';

import { prioritizeAffinity } from './affinity';

const a = { provider: { id: 'a' } };
const b = { provider: { id: 'b' } };
const c = { provider: { id: 'c' } };

describe('prioritizeAffinity', () => {
  test('moves the bound provider to the front', () => {
    expect(prioritizeAffinity([a, b, c], 'b')).toEqual([b, a, c]);
  });

  test('keeps order when the provider is already first', () => {
    expect(prioritizeAffinity([a, b, c], 'a')).toEqual([a, b, c]);
  });

  test('keeps order for a missing or undefined provider', () => {
    expect(prioritizeAffinity([a, b, c], 'missing')).toEqual([a, b, c]);
    expect(prioritizeAffinity([a, b, c], undefined)).toEqual([a, b, c]);
  });

  test('does not mutate the input array', () => {
    const input = [a, b, c];
    prioritizeAffinity(input, 'c');
    expect(input).toEqual([a, b, c]);
  });
});
