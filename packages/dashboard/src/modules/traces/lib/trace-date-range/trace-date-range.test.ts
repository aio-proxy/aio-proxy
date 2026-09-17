import { describe, expect, test } from '@rstest/core';

import { toPickerRange, toQueryRange } from './trace-date-range';

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
});
