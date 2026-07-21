export interface DateTimeRange {
  readonly from: Date;
  readonly to: Date;
}

export interface DateTimeRangePreset {
  readonly id: string;
  readonly label: string;
  readonly resolve: (now: Date) => DateTimeRange;
}
