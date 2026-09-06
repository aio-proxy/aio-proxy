import { expect, test } from 'bun:test';

import { normalizedClose, normalizeCloseCode, truncateCloseReason } from './close-code';

test('codes the client WebSocket accepts pass through unchanged', () => {
  for (const code of [1000, 1001, 1002, 1003, 1007, 1010, 1011, 1014, 3000, 4000, 4999]) {
    expect(normalizeCloseCode(code)).toBe(code);
  }
});

test('every code the client WebSocket would throw on becomes 1011', () => {
  // `WebSocket.close()` throws InvalidAccessError for these; the relay must never
  // forward one upstream, and it keeps a single table by normalizing both directions.
  for (const code of [undefined, 999, 1004, 1005, 1006, 1015, 2999, 5000, 0, -1]) {
    expect(normalizeCloseCode(code)).toBe(1011);
  }
});

test('a non-integer code becomes 1011', () => {
  // Bun 1.4.2's client `WebSocket.close()` truncates `1000.5` rather than throwing, so
  // the guard is stricter than the accept ranges alone: a fractional code never
  // reaches a peer as some silently-rounded neighbour.
  expect(normalizeCloseCode(1000.5)).toBe(1011);
  expect(normalizeCloseCode(Number.NaN)).toBe(1011);
  expect(normalizeCloseCode(Number.POSITIVE_INFINITY)).toBe(1011);
});

test('a reason longer than 123 UTF-8 bytes is truncated on a code-point boundary', () => {
  const ascii = 'a'.repeat(200);
  const truncatedAscii = truncateCloseReason(ascii)!;
  expect(new TextEncoder().encode(truncatedAscii).byteLength).toBe(123);

  // 3 bytes each: a naive slice(0, 123) would cut mid-sequence and produce U+FFFD.
  const multibyte = '好'.repeat(200);
  const truncatedMultibyte = truncateCloseReason(multibyte)!;
  expect(new TextEncoder().encode(truncatedMultibyte).byteLength).toBeLessThanOrEqual(123);
  expect(truncatedMultibyte).toBe('好'.repeat(41));
  expect(truncatedMultibyte).not.toContain('�');
});

test('a short reason and an absent reason are left alone', () => {
  expect(truncateCloseReason('going away')).toBe('going away');
  expect(truncateCloseReason(undefined)).toBeUndefined();
  expect(truncateCloseReason('')).toBeUndefined();
});

test('a normalized code drops its reason, while a passed-through code keeps a truncated one', () => {
  expect(normalizedClose(1006, 'Failed to connect')).toEqual({ code: 1011 });
  expect(normalizedClose(4001, 'session ended')).toEqual({ code: 4001, reason: 'session ended' });
  expect(normalizedClose(1000, 'a'.repeat(200)).reason).toHaveLength(123);
});
