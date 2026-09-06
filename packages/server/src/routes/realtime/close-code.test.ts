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

  // 2 bytes each and 123 % 2 === 1, so the cap falls *inside* the 62nd character. This is the
  // width where the shipped code-point walk and a naive byte slice disagree most loudly — the
  // slice keeps a dangling lead byte, which `TextDecoder` renders as U+FFFD and which pushes
  // the result to 125 bytes, over the cap the client enforces. The U+FFFD assertion is
  // deliberately first: it is the property this test exists for, and behind the byte-length
  // assertion it would never be the one to report.
  const twoByte = 'é'.repeat(200);
  const truncatedTwoByte = truncateCloseReason(twoByte)!;
  expect(truncatedTwoByte).not.toContain('�');
  expect(new TextEncoder().encode(truncatedTwoByte).byteLength).toBe(122);
  expect(truncatedTwoByte).toBe('é'.repeat(61));

  // 3 bytes each, and 123 % 3 === 0, so 41 characters land exactly on the cap: this is the
  // one multibyte width where a byte slice and a code-point walk agree. No U+FFFD assertion
  // belongs here — every possible implementation satisfies it, so it would read as coverage
  // while being unable to fail.
  const multibyte = '好'.repeat(200);
  const truncatedMultibyte = truncateCloseReason(multibyte)!;
  expect(new TextEncoder().encode(truncatedMultibyte).byteLength).toBeLessThanOrEqual(123);
  expect(truncatedMultibyte).toBe('好'.repeat(41));

  // 4 bytes each and 123 % 4 === 3, so a byte slice necessarily cuts mid-sequence here too.
  // Same ordering as the 2-byte case and for the same reason.
  const astral = '\u{1F600}'.repeat(50);
  const truncatedAstral = truncateCloseReason(astral)!;
  expect(truncatedAstral).not.toContain('�');
  expect(new TextEncoder().encode(truncatedAstral).byteLength).toBe(120);
  expect(truncatedAstral).toBe('\u{1F600}'.repeat(30));
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
