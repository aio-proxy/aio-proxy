import { describe, expect, test } from '@rstest/core';

import { formatTraceRangeLabel, toPickerRange, toQueryRange } from './trace-date-range';

describe('trace date range', () => {
  test('maps active query instants to exact picker times', () => {
    const range = toPickerRange({
      startedAfter: '2026-07-20T08:15:00.000Z',
      startedBefore: '2026-07-20T09:45:59.999Z',
    });

    expect(range.from.toISOString()).toBe('2026-07-20T08:15:00.000Z');
    expect(range.to.toISOString()).toBe('2026-07-20T09:45:59.999Z');
  });

  test('commits a complete range without discarding custom times', () => {
    const range = toQueryRange({
      from: new Date(2026, 6, 20, 8, 15, 0, 0),
      to: new Date(2026, 6, 20, 9, 45, 59, 999),
    });

    expect(range).toEqual({
      startedAfter: new Date(2026, 6, 20, 8, 15, 0, 0).toISOString(),
      startedBefore: new Date(2026, 6, 20, 9, 45, 59, 999).toISOString(),
    });
  });

  test('drops the repeated date inside a single day but keeps it across days', () => {
    const sameDay = formatTraceRangeLabel({
      startedAfter: new Date(2026, 6, 20, 0, 0, 0, 0).toISOString(),
      startedBefore: new Date(2026, 6, 20, 23, 59, 59, 999).toISOString(),
    });
    const crossDay = formatTraceRangeLabel({
      startedAfter: new Date(2026, 6, 20, 22, 0, 0, 0).toISOString(),
      startedBefore: new Date(2026, 6, 21, 2, 0, 0, 0).toISOString(),
    });

    expect(sameDay).toBe('07-20 00:00 – 23:59');
    // 跨天时右端必须带上日期，否则 22:00 – 02:00 读起来像是倒着选的。
    expect(crossDay).toBe('07-20 22:00 – 07-21 02:00');
  });
});
