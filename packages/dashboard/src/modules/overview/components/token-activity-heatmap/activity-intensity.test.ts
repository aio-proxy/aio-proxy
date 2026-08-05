import { describe, expect, test } from '@rstest/core';

import { activityIntensityLevels } from './activity-intensity';

describe('activityIntensityLevels', () => {
  test('assigns level zero to empty activity', () => {
    expect(activityIntensityLevels([0n, 0n, 0n])).toEqual([0, 0, 0]);
  });

  test('uses positive-value quantiles to distinguish skewed token activity', () => {
    expect(activityIntensityLevels([0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 100n])).toEqual([
      0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4,
    ]);
  });
});
