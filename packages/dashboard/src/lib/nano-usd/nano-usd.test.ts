import { describe, expect, test } from '@rstest/core';

import { compactNanoUsdDisplay, createUsageValueFormatter, formatNanoUsd } from './nano-usd';

describe('nano-USD formatting', () => {
  test('formats nano-USD without crossing the Number precision boundary', () => {
    expect(formatNanoUsd(2n, 'en-US')).toBe('$0.000000002');
    expect(formatNanoUsd(9_007_199_254_740_993_000_000_002n, 'en-US')).toBe('$9,007,199,254,740,993.000000002');
  });

  test('preserves meaningful USD precision without compacting cost', () => {
    const formatCost = createUsageValueFormatter('cost', 'en-US');

    expect(formatCost(0.0049)).toBe('$0.0049');
    expect(formatCost(12_345.67)).toBe('$12,345.67');
  });

  test('formats token and request metrics as compact integers', () => {
    const formatTokens = createUsageValueFormatter('tokens', 'en-US');
    const formatRequests = createUsageValueFormatter('requests', 'en-US');

    expect(formatTokens(1_200)).toBe('1.2K');
    expect(formatRequests(1_234_567)).toBe('1M');
  });
});

test('compact display uses <$0.01 when two-decimal USD would round to zero', () => {
  expect(compactNanoUsdDisplay(2n, 'en-US')).toEqual({
    exact: '$0.000000002',
    compact: undefined,
    subCent: true,
  });
  expect(compactNanoUsdDisplay(10_000_000n, 'en-US')).toEqual({
    exact: '$0.01',
    compact: '$0.01',
    subCent: false,
  });
  expect(compactNanoUsdDisplay(0n, 'en-US').subCent).toBe(false);
});
