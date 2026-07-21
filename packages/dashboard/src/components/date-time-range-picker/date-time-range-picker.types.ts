export type DateTimeInput = string | number | Date;

export interface DateTimeRangeValue {
  readonly from: DateTimeInput;
  readonly to: DateTimeInput;
}

export interface ResolvedDateTimeRangeValue {
  readonly from: Date;
  readonly to: Date;
}

export interface DateTimeRange {
  readonly from: Date;
  readonly to: Date;
}

export interface DateTimeRangePreset {
  readonly id: string;
  readonly label: string;
  readonly resolve: (now: Date) => DateTimeRange;
}

export interface DateTimeRangeDraft {
  readonly from: string;
  readonly to: string;
}
