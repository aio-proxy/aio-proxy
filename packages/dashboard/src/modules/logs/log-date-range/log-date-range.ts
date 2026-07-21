import type { DateTimeRange } from "@/components/date-time-range-picker";

type QueryRange = {
  readonly startedAfter: string;
  readonly completedBefore: string;
};

export const toPickerRange = (range: QueryRange): DateTimeRange => ({
  from: new Date(range.startedAfter),
  to: new Date(range.completedBefore),
});

export function toQueryRange(range: DateTimeRange): QueryRange;
export function toQueryRange(range: undefined): undefined;
export function toQueryRange(range: DateTimeRange | undefined): QueryRange | undefined {
  return range === undefined
    ? undefined
    : {
        startedAfter: range.from.toISOString(),
        completedBefore: range.to.toISOString(),
      };
}
