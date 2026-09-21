import { describe, expect, it } from '@rstest/core';

import { createWaterfallTicks } from './trace-waterfall-ticks';

describe('createWaterfallTicks', () => {
  it('按四分位切总时长', () => {
    expect(createWaterfallTicks(2000)).toEqual([
      { ratio: 0, durationMs: 0 },
      { ratio: 0.25, durationMs: 500 },
      { ratio: 0.5, durationMs: 1000 },
      { ratio: 0.75, durationMs: 1500 },
      { ratio: 1, durationMs: 2000 },
    ]);
  });

  it('总时长为 0 时刻度也不塌成 NaN', () => {
    expect(createWaterfallTicks(0).map((tick) => tick.durationMs)).toEqual([0, 0, 0, 0, 0]);
  });
});
