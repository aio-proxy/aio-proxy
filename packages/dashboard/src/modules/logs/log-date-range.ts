import { endOfDay, startOfDay } from "date-fns";

export type LogDateRange = {
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
};

type QueryRange = {
  readonly startedAfter: string;
  readonly completedBefore: string;
};

export const toPickerRange = (range: QueryRange): LogDateRange => ({
  from: new Date(range.startedAfter),
  to: new Date(range.completedBefore),
});

export const toQueryRange = (range: LogDateRange): QueryRange | undefined => {
  if (!range.from || !range.to) return undefined;
  return {
    startedAfter: startOfDay(range.from).toISOString(),
    completedBefore: endOfDay(range.to).toISOString(),
  };
};
