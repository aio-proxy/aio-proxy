import { expect, test } from 'bun:test';

import { resolveUsageRange, usageBucketKeys, usageLocalDate } from './usage-range';

const NOW = new Date('2026-09-25T08:30:00.000Z');

test('resolves 24h as a rolling hour window and day ranges as aligned local midnights', () => {
  const hourly = resolveUsageRange('24h', NOW);
  expect(hourly.bucketUnit).toBe('hour');
  expect(hourly.end).toEqual(NOW);
  expect(NOW.getTime() - hourly.start.getTime()).toBe(24 * 60 * 60 * 1000);

  for (const [range, days] of [
    ['7d', 7],
    ['14d', 14],
    ['30d', 30],
  ] as const) {
    const resolved = resolveUsageRange(range, NOW);
    expect(resolved.bucketUnit).toBe('day');
    expect(resolved.end).toEqual(NOW);
    expect(resolved.start.getHours()).toBe(0);
    expect(resolved.start.getMinutes()).toBe(0);
    const expected = new Date(NOW);
    expected.setHours(0, 0, 0, 0);
    expected.setDate(expected.getDate() - (days - 1));
    expect(usageLocalDate(resolved.start)).toBe(usageLocalDate(expected));
  }
});

test('emits a dense bucket key list so charts never render gaps', () => {
  const hourly = resolveUsageRange('24h', NOW);
  const hourKeys = usageBucketKeys('24h', hourly.start, hourly.end);
  expect(hourKeys).toHaveLength(24);
  expect(hourKeys.map(({ identity }) => identity)).toEqual(Array.from({ length: 24 }, (_, index) => index));

  const daily = resolveUsageRange('14d', NOW);
  const dayKeys = usageBucketKeys('14d', daily.start, daily.end);
  expect(dayKeys).toHaveLength(14);
  expect(dayKeys[0]?.identity).toBe(usageLocalDate(daily.start));
});

test('pads month and day so the key matches SQLite strftime day buckets', () => {
  // Constructed in local time on purpose: usageLocalDate is local-time by design, and this
  // string is the identity of a day bucket, so it must match strftime('%Y-%m-%d', ...).
  expect(usageLocalDate(new Date(2026, 8, 5))).toBe('2026-09-05');
});
