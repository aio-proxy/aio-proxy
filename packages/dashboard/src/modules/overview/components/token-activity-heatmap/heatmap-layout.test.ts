import { describe, expect, test } from '@rstest/core';

import type { OverviewActivityData } from '../../services/overview-service';
import { buildHeatmapWeeks } from './heatmap-layout';

const activity = (from: string, to: string): OverviewActivityData => {
  const items = [];
  for (
    let value = new Date(`${from}T00:00:00Z`);
    value <= new Date(`${to}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + 1)
  ) {
    items.push({
      date: value.toISOString().slice(0, 10),
      totalTokens: 0n,
      models: [],
    });
  }
  return { from, to, items };
};

describe('buildHeatmapWeeks', () => {
  test('returns 52 Sunday-aligned week columns with trailing null pads', () => {
    const result = buildHeatmapWeeks(activity('2025-08-10', '2026-08-05'));

    expect(result.weeks).toHaveLength(52);
    expect(result.weeks.every((week) => week.length === 7)).toBe(true);
    expect(result.weeks[51]?.slice(4)).toEqual([null, null, null]);
  });

  test('adds markers when a month begins', () => {
    const result = buildHeatmapWeeks(activity('2025-08-10', '2026-08-05'));

    expect(result.monthMarkers).toContainEqual({ index: 3, label: 'Sep' });
    expect(result.monthMarkers).toContainEqual({ index: 50, label: 'Aug' });
  });
});
