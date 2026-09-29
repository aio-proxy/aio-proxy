import type { UsageOverviewRange } from '@aio-proxy/types';

export type ResolvedUsageRange = {
  readonly start: Date;
  readonly end: Date;
  readonly bucketUnit: 'hour' | 'day';
};

/** `identity` is the grouping value produced on the SQL side (an hour offset in `0..23`, or a local
 * date string for day buckets); `key` is the ISO label charts render. The two must always be
 * emitted as a pair, otherwise rows and buckets no longer line up. */
export type UsageRangeBucket = {
  readonly identity: string | number;
  readonly key: string;
};

export function resolveUsageRange(range: UsageOverviewRange, now: Date): ResolvedUsageRange {
  if (range === '24h') {
    return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now, bucketUnit: 'hour' };
  }
  let days = 30;
  if (range === '7d') days = 7;
  else if (range === '14d') days = 14;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return { start, end: now, bucketUnit: 'day' };
}

export function usageBucketKeys(range: UsageOverviewRange, start: Date, end: Date): readonly UsageRangeBucket[] {
  if (range === '24h') {
    return Array.from({ length: 24 }, (_, index) => ({
      identity: index,
      key: new Date(start.getTime() + index * 60 * 60 * 1000).toISOString(),
    }));
  }
  const keys: UsageRangeBucket[] = [];
  const day = new Date(start);
  while (day <= end) {
    keys.push({ identity: usageLocalDate(day), key: day.toISOString() });
    day.setDate(day.getDate() + 1);
  }
  return keys;
}

export function usageLocalDate(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
