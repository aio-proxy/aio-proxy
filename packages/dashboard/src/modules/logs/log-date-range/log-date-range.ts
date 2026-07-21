import type { ResolvedDateTimeRangeValue } from "@/components/date-time-range-picker";

type QueryRange = {
  readonly startedAfter: string;
  readonly completedBefore: string;
};

export const toPickerRange = (range: QueryRange): ResolvedDateTimeRangeValue => ({
  from: new Date(range.startedAfter),
  to: new Date(range.completedBefore),
});

export function toQueryRange(range: ResolvedDateTimeRangeValue): QueryRange;
export function toQueryRange(range: undefined): undefined;
export function toQueryRange(range: ResolvedDateTimeRangeValue | undefined): QueryRange | undefined {
  return range === undefined
    ? undefined
    : {
        startedAfter: range.from.toISOString(),
        completedBefore: range.to.toISOString(),
      };
}
