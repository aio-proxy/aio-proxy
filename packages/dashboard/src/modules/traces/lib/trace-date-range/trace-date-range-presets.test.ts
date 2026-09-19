import { describe, expect, test } from '@rstest/core';
import { endOfMinute } from 'date-fns';

import { createTraceDateTimeRangePresets } from './trace-date-range-presets';

const durations = {
  '15m': 15,
  '1h': 60,
  '3h': 180,
  '6h': 360,
  '12h': 720,
  '24h': 1_440,
  '3d': 4_320,
  '7d': 10_080,
} as const;

describe('trace date time range presets', () => {
  test.each(Object.entries(durations))('resolves %s to a fixed minute-inclusive range', (id, minutes) => {
    const now = new Date(2026, 6, 20, 12, 34, 45, 678);
    const preset = createTraceDateTimeRangePresets().find((candidate) => candidate.id === id);

    expect(preset).toBeDefined();
    const range = preset?.resolve(now);
    expect(range?.to).toEqual(endOfMinute(now));
    expect((range?.to.getTime() ?? 0) - (range?.from.getTime() ?? 0)).toBe(minutes * 60_000 - 1);
  });
});
