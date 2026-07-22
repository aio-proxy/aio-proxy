import type { DateTimeRange } from "@/components/date-time-range-picker";

type QueryRange = {
  readonly startedAfter: string;
  readonly completedBefore: string;
};

export const toPickerRange = (range: QueryRange): DateTimeRange => ({
  from: new Date(range.startedAfter),
  to: new Date(range.completedBefore),
});

export const toQueryRange = (range: DateTimeRange): QueryRange => ({
  startedAfter: range.from.toISOString(),
  completedBefore: range.to.toISOString(),
});
