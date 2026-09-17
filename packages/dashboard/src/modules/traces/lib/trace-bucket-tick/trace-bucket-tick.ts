import type { DashboardTraceSummaryBucket, DashboardTraceSummaryBucketSize } from '@aio-proxy/types';

// 刻度的时间部分只跟桶宽有关：1h 桶的分钟恒为 00，写出来是噪声；
// 1d 桶本身就是一天，时间部分留空，标签由日期承担 —— 服务端只在跨度超过 180h 时
// 才选 1d，这时桶数必然 ≥ 8，spansDays 一定成立，日期不会缺。
const timeOptions: Record<DashboardTraceSummaryBucketSize, Intl.DateTimeFormatOptions> = {
  '1m': { hour: '2-digit', minute: '2-digit' },
  '5m': { hour: '2-digit', minute: '2-digit' },
  '30m': { hour: '2-digit', minute: '2-digit' },
  '1h': { hour: '2-digit' },
  '1d': {},
};

const dateOptions: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };

// 本地日期的比较键。用不着好看，只要同一天相等、跨天不等，且跟着用户时区走。
const localDay = (at: string) => new Date(at).toDateString();

/**
 * X 轴刻度的格式化器。带不带日期取决于这一屏画的桶实际跨不跨天，不看桶宽：
 * 同一档桶宽两种情况都可能出现 —— 30m 档既覆盖普通的 24h 范围，也覆盖 3d 预设的 72h；
 * 1h 档同理覆盖 7d 预设。只给时分的话，一天之外的范围会排出好几组重复的
 * 00:00…23:00，看不出哪里跨了天。
 */
export const createBucketTickFormat = (
  locale: string,
  bucket: DashboardTraceSummaryBucketSize,
  buckets: readonly DashboardTraceSummaryBucket[],
): Intl.DateTimeFormat => {
  const time = timeOptions[bucket];
  const first = buckets.at(0);
  const last = buckets.at(-1);
  const spansDays = first !== undefined && last !== undefined && localDay(first.at) !== localDay(last.at);
  return new Intl.DateTimeFormat(locale, spansDays ? { ...dateOptions, ...time } : time);
};
