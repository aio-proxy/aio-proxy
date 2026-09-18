import { expect, test } from '@rstest/core';

import { estimateQuotaPeriodNanoUsd, quotaPeriodEstimateIsApproximate } from './quota-period-estimate';

test('divides used spend by consumed remaining so $6.15 at 69% remaining is about $19.84', () => {
  const used = 6_150_000_000n;
  const estimated = estimateQuotaPeriodNanoUsd(used, 0.69);
  expect(estimated).toBeDefined();
  expect(Number(estimated) / 1_000_000_000).toBeCloseTo(19.84, 2);
});

test('returns used itself when the window is empty', () => {
  expect(estimateQuotaPeriodNanoUsd(44_080_000_000n, 0)).toBe(44_080_000_000n);
});

test('hides the period total when nothing has been consumed', () => {
  expect(estimateQuotaPeriodNanoUsd(6_150_000_000n, 1)).toBeUndefined();
  expect(estimateQuotaPeriodNanoUsd(6_150_000_000n, 1.2)).toBeUndefined();
  expect(estimateQuotaPeriodNanoUsd(6_150_000_000n, Number.NaN)).toBeUndefined();
});

test('marks a period estimate approximate when consumed quota is under 10%', () => {
  expect(quotaPeriodEstimateIsApproximate(0.91)).toBe(true);
  expect(quotaPeriodEstimateIsApproximate(0.69)).toBe(false);
  expect(quotaPeriodEstimateIsApproximate(1)).toBe(false);
});
