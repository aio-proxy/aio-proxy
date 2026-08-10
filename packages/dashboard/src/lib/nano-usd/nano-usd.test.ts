import { describe, expect, test } from '@rstest/core';

import { createUsageValueFormatter, formatNanoUsd } from './nano-usd';

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
