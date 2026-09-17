import { format, isSameDay } from 'date-fns';

import type { DateTimeRange } from '@/components/date-time-range-picker';

type QueryRange = {
  readonly startedAfter: string;
  readonly startedBefore: string;
};

// 工具栏里这个按钮要和筛选、实时挤在同一行，选择器默认的
// `yyyy-MM-dd HH:mm – yyyy-MM-dd HH:mm` 有 33 个字符，会把整行顶开。年份在只留 45 天
// 的调用链里没有信息量，同一天的日期也没必要写两遍。数字格式各语言通用，不进 i18n。
const LABEL_PATTERN = 'MM-dd HH:mm';

export const formatTraceRangeLabel = (range: QueryRange): string => {
  const from = new Date(range.startedAfter);
  const to = new Date(range.startedBefore);
  return `${format(from, LABEL_PATTERN)} – ${format(to, isSameDay(from, to) ? 'HH:mm' : LABEL_PATTERN)}`;
};

export const toPickerRange = (range: QueryRange): DateTimeRange => ({
  from: new Date(range.startedAfter),
  to: new Date(range.startedBefore),
});

export const toQueryRange = (range: DateTimeRange): QueryRange => ({
  startedAfter: range.from.toISOString(),
  startedBefore: range.to.toISOString(),
});
