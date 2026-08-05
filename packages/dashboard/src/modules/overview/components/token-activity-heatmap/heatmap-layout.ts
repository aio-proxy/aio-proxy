import { getLocale } from '@aio-proxy/i18n';

import type { OverviewActivityData } from '../../services/overview-service';

export type ActivityCell = OverviewActivityData['items'][number];

interface HeatmapMonthMarker {
  readonly index: number;
  readonly label: string;
}

interface HeatmapLayout {
  readonly weeks: (ActivityCell | null)[][];
  readonly monthMarkers: HeatmapMonthMarker[];
}

const DAYS_PER_WEEK = 7;
const WEEK_COUNT = 52;

export const buildHeatmapWeeks = (activity: OverviewActivityData): HeatmapLayout => {
  const weeks = Array.from({ length: WEEK_COUNT }, () => Array<ActivityCell | null>(DAYS_PER_WEEK).fill(null));
  const monthFormatter = new Intl.DateTimeFormat(getLocale(), { month: 'short', timeZone: 'UTC' });
  const monthMarkers: HeatmapMonthMarker[] = [];
  const start = new Date(`${activity.from}T00:00:00.000Z`);

  for (const item of activity.items) {
    const date = new Date(`${item.date}T00:00:00.000Z`);
    const dayOffset = Math.round((date.getTime() - start.getTime()) / 86_400_000);
    const weekIndex = Math.floor(dayOffset / DAYS_PER_WEEK);
    const dayIndex = dayOffset % DAYS_PER_WEEK;
    if (weekIndex < 0 || weekIndex >= WEEK_COUNT || dayIndex < 0) continue;

    weeks[weekIndex]![dayIndex] = item;
    if (date.getUTCDate() === 1) {
      monthMarkers.push({ index: weekIndex, label: monthFormatter.format(date) });
    }
  }

  return { weeks, monthMarkers };
};
