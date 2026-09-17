import type { DateTimeRange } from '@/components/date-time-range-picker';

type QueryRange = {
  readonly startedAfter: string;
  readonly startedBefore: string;
};

export const toPickerRange = (range: QueryRange): DateTimeRange => ({
  from: new Date(range.startedAfter),
  to: new Date(range.startedBefore),
});

export const toQueryRange = (range: DateTimeRange): QueryRange => ({
  startedAfter: range.from.toISOString(),
  startedBefore: range.to.toISOString(),
});
