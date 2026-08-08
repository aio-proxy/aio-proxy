import { differenceInCalendarDays, getDate } from 'date-fns';

import type { OverviewActivityData } from '../../services/overview-service';
import { formatActivityMonth, parseLocalDay } from './activity-date';

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
  const monthMarkers: HeatmapMonthMarker[] = [];
  const start = parseLocalDay(activity.from);

  for (const item of activity.items) {
    const date = parseLocalDay(item.date);
    const dayOffset = differenceInCalendarDays(date, start);
    const weekIndex = Math.floor(dayOffset / DAYS_PER_WEEK);
    const dayIndex = dayOffset % DAYS_PER_WEEK;
    if (weekIndex < 0 || weekIndex >= WEEK_COUNT || dayIndex < 0) continue;

    weeks[weekIndex]![dayIndex] = item;
    if (getDate(date) === 1) {
      monthMarkers.push({ index: weekIndex, label: formatActivityMonth(date) });
    }
  }

  return { weeks, monthMarkers };
};
