import { expect, test } from 'bun:test';

import { usageLocalDate } from '../../index';
import { usageDaily } from '../../schema';
import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';

test('today totals include all models, exclude yesterday, and preserve integer precision', () => {
  const handle = openTestDb();
  try {
    handle.db
      .insert(usageDaily)
      .values([
        {
          localDay: '2026-10-05',
          modelDimension: 'model-a',
          inputTokens: '9007199254740993',
          outputTokens: '9007199254740993',
          estimatedCostNanoUsd: '9223372036854775808',
        },
        {
          localDay: '2026-10-05',
          modelDimension: 'model-b',
          inputTokens: '7',
          outputTokens: '9007199254740993',
          estimatedCostNanoUsd: '9223372036854775808',
        },
        {
          localDay: '2026-10-04',
          modelDimension: 'model-a',
          inputTokens: '100',
          outputTokens: '200',
          estimatedCostNanoUsd: '300',
        },
      ])
      .run();

    expect(createTraceStore(handle.db).todayUsage(new Date(2026, 9, 5, 12))).toEqual({
      inputTokens: 9007199254741000n,
      outputTokens: 18014398509481986n,
      estimatedCostNanoUsd: 18446744073709551616n,
    });
  } finally {
    handle.close();
  }
});

test('today totals switch days at local midnight', () => {
  const handle = openTestDb();
  try {
    handle.db
      .insert(usageDaily)
      .values([
        {
          localDay: '2026-10-05',
          modelDimension: 'model-a',
          inputTokens: '10',
          outputTokens: '20',
          estimatedCostNanoUsd: '30',
        },
        {
          localDay: '2026-10-06',
          modelDimension: 'model-a',
          inputTokens: '40',
          outputTokens: '50',
          estimatedCostNanoUsd: '60',
        },
      ])
      .run();

    const store = createTraceStore(handle.db);
    const beforeMidnight = new Date(2026, 9, 5, 23, 59);
    const afterMidnight = new Date(2026, 9, 6, 0, 1);
    expect(usageLocalDate(beforeMidnight)).toBe('2026-10-05');
    expect(usageLocalDate(afterMidnight)).toBe('2026-10-06');
    expect(store.todayUsage(beforeMidnight)).toEqual({
      inputTokens: 10n,
      outputTokens: 20n,
      estimatedCostNanoUsd: 30n,
    });
    expect(store.todayUsage(afterMidnight)).toEqual({
      inputTokens: 40n,
      outputTokens: 50n,
      estimatedCostNanoUsd: 60n,
    });
  } finally {
    handle.close();
  }
});

test('an empty table returns zero totals', () => {
  const handle = openTestDb();
  try {
    expect(createTraceStore(handle.db).todayUsage(new Date(2026, 9, 5, 12))).toEqual({
      inputTokens: 0n,
      outputTokens: 0n,
      estimatedCostNanoUsd: 0n,
    });
  } finally {
    handle.close();
  }
});
