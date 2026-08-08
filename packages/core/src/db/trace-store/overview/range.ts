import type { DashboardOverviewRange } from '@aio-proxy/types';

export type ResolvedRange = {
  readonly start: Date;
  readonly end: Date;
  readonly bucketUnit: 'hour' | 'day';
};

export function resolveRange(range: DashboardOverviewRange, now: Date): ResolvedRange {
  if (range === '24h') {
    return { start: new Date(now.getTime() - 24 * 60 * 60 * 1000), end: now, bucketUnit: 'hour' };
  }
  let days = 90;
  if (range === '7d') days = 7;
  else if (range === '30d') days = 30;
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (days - 1));
  return { start, end: now, bucketUnit: 'day' };
}
