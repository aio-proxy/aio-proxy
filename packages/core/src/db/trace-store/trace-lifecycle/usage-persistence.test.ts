import { describe, expect, test } from 'bun:test';

import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';
import { completion, rootStart } from '../trace-store.test-support';

describe('trace usage persistence', () => {
  test('adds daily fallback tokens exactly in SQLite', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot(rootStart());
      expect(
        store.complete(
          completion({
            summary: {
              finalProviderId: 'provider-b',
              finalModelId: 'model-b',
              finalHttpStatus: 200,
              usage: {
                providerId: 'provider-b',
                modelId: 'model-b',
                inputTokens: Number.MAX_SAFE_INTEGER,
                outputTokens: 2,
              },
            },
          }),
        ),
      ).toBe(true);

      const row = handle.sqlite
        .query<{ totalTokens: string }, []>('select cast(total_tokens as text) as totalTokens from usage_daily')
        .get();
      expect(row?.totalTokens).toBe('9007199254740993');
    } finally {
      handle.close();
    }
  });

  test('does not count provider and model metadata as usage', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot(rootStart());
      expect(
        store.complete(
          completion({
            summary: {
              finalProviderId: 'provider-b',
              finalModelId: 'model-b',
              finalHttpStatus: 200,
              usage: { providerId: 'provider-b', modelId: 'model-b' },
            },
          }),
        ),
      ).toBe(true);

      const row = handle.sqlite
        .query<{ totalTokens: string; usageRequestCount: string }, []>(
          'select cast(total_tokens as text) as totalTokens, cast(usage_request_count as text) as usageRequestCount from usage_daily',
        )
        .get();
      expect(row).toEqual({ totalTokens: '0', usageRequestCount: '0' });
    } finally {
      handle.close();
    }
  });
});
