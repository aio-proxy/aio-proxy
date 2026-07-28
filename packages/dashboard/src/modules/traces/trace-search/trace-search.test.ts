import { describe, expect, test } from '@rstest/core';

import { createDefaultTraceSearch, parseTraceSearch, withTraceFilters } from './trace-search';

const now = new Date('2026-07-12T12:00:00.000Z');

describe('trace search', () => {
  test('parses trace-specific URL filters into typed search state', () => {
    expect(
      parseTraceSearch(
        {
          page: '2',
          pageSize: '20',
          otelStatusCode: 'ERROR',
          terminationReason: 'cancelled',
          sessionSource: 'openai-prompt-cache',
          sessionId: 'cache-a',
          finalHttpStatus: '503',
        },
        now,
      ),
    ).toMatchObject({
      page: 2,
      pageSize: 20,
      otelStatusCode: 'ERROR',
      terminationReason: 'cancelled',
      sessionSource: 'openai-prompt-cache',
      sessionId: 'cache-a',
      finalHttpStatus: 503,
    });
  });

  test.each([
    { startedAfter: 'not-a-date' },
    { startedBefore: 'not-a-date' },
    { page: '0' },
    { pageSize: '25' },
    { otelStatusCode: 'BAD' },
    { terminationReason: 'success' },
    { finalHttpStatus: '99' },
    { finalHttpStatus: '600' },
  ])('resets malformed search values to the current-day defaults: %j', (raw) => {
    expect(parseTraceSearch(raw, now)).toEqual(createDefaultTraceSearch(now));
  });

  test('resets pagination and removes cleared filters', () => {
    expect(
      withTraceFilters(
        {
          ...createDefaultTraceSearch(now),
          page: 3,
          requestId: 'request-a',
          sessionId: 'session-a',
        },
        { requestId: undefined, finalProviderId: 'provider-a' },
      ),
    ).toEqual({
      ...createDefaultTraceSearch(now),
      page: 1,
      sessionId: 'session-a',
      finalProviderId: 'provider-a',
    });
  });
});
