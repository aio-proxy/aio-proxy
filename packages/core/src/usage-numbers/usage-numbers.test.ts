import { describe, expect, test } from 'bun:test';

import { nanoUsdToUsd, parseSqliteInteger, usdToNanoUsd } from '.';

describe('usage number boundaries', () => {
  test('converts USD to nano-USD with one rounding step', () => {
    expect(usdToNanoUsd(0.000_000_002)).toBe(2);
    expect(usdToNanoUsd(0.1)).toBe(100_000_000);
    expect(nanoUsdToUsd(250_000_000)).toBe(0.25);
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, -1])('rejects invalid USD %p', (value) => {
    expect(() => usdToNanoUsd(value)).toThrow();
  });

  test('rejects nano-USD outside the safe single-request range', () => {
    expect(() => usdToNanoUsd((Number.MAX_SAFE_INTEGER + 1) / 1_000_000_000)).toThrow();
  });

  test('parses exact SQLite integer text', () => {
    expect(parseSqliteInteger('9007199254740993')).toBe(9_007_199_254_740_993n);
    expect(() => parseSqliteInteger('1.5')).toThrow();
  });
});
