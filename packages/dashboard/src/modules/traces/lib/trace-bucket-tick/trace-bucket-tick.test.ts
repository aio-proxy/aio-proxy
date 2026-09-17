import type { DashboardTraceSummaryBucketSize } from '@aio-proxy/types';
import { describe, expect, test } from '@rstest/core';

import { createBucketTickFormat } from './trace-bucket-tick';

// 用本地时间构造，断言才跟运行环境的时区无关。取 08:00 避开夏令时切换那一两个小时。
const at = (day: number, hour = 8) => ({ at: new Date(2026, 6, day, hour).toISOString(), success: 0, error: 0 });
const sameClockOnTwoDays = [at(27).at, at(28).at] as const;

describe('bucket tick format', () => {
  // 3d 预设落在 30m 档（72h / 144 桶），7d 预设落在 1h 档。两档都同时覆盖着
  // 一天之内的范围，所以只看桶宽分不出要不要写日期 —— 这两个预设都曾因此
  // 排出好几组一模一样的 00:00…23:00。
  test.each<DashboardTraceSummaryBucketSize>(['30m', '1h'])(
    'tells the days apart when the %s buckets span more than one local day',
    (bucket) => {
      const format = createBucketTickFormat('en-US', bucket, [at(27), at(28, 20), at(29, 8)]);

      const [first, second] = sameClockOnTwoDays.map((value) => format.format(new Date(value)));

      expect(first).not.toBe(second);
    },
  );

  test('leaves the date out while every bucket is on the same local day', () => {
    const format = createBucketTickFormat('en-US', '30m', [at(27, 1), at(27, 12), at(27, 23)]);

    const [first, second] = sameClockOnTwoDays.map((value) => format.format(new Date(value)));

    expect(first).toBe(second);
  });

  test('always labels a daily bucket, even when the range holds a single one', () => {
    const format = createBucketTickFormat('en-US', '1d', [at(27, 0)]);

    // 1d 档的时间部分是空的，不补日期就会退化成一个什么都不写的格式化器。
    expect(format.format(new Date(at(27, 0).at))).not.toBe('');
  });
});
