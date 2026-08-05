import { describe, expect, test } from '@rstest/core';

import {
  createDefaultTraceSearch,
  resolveTraceSearch,
  toTraceUrlSearch,
  traceSearchSchema,
  withTraceFilters,
} from './trace-search';

const now = new Date('2026-07-12T12:00:00.000Z');

describe('trace search', () => {
  test('validates cursor pagination and trace filters into typed URL state', () => {
    expect(
      traceSearchSchema.parse({
        pageSize: '20',
        pageToken: 'next-page-token',
        otelStatusCode: 'ERROR',
        terminationReason: 'cancelled',
        sessionSource: 'openai-prompt-cache',
        sessionId: 'cache-a',
        finalHttpStatus: '503',
      }),
    ).toEqual({
      pageSize: 20,
      pageToken: 'next-page-token',
      otelStatusCode: 'ERROR',
      terminationReason: 'cancelled',
      sessionSource: 'openai-prompt-cache',
      sessionId: 'cache-a',
      finalHttpStatus: 503,
    });
  });

  test.each([
    ['startedAfter', { startedAfter: 'not-a-date' }, undefined],
    ['startedBefore', { startedBefore: 'not-a-date' }, undefined],
    ['pageSize', { pageSize: '25' }, 50],
    ['pageToken', { pageToken: '' }, undefined],
    ['otelStatusCode', { otelStatusCode: 'BAD' }, undefined],
    ['terminationReason', { terminationReason: 'success' }, undefined],
    ['finalHttpStatus', { finalHttpStatus: '99' }, undefined],
    ['traceId', { traceId: 'ABCDEF0123456789ABCDEF0123456789' }, undefined],
  ])('falls back only the malformed %s URL field', (field, raw, fallback) => {
    const parsed = traceSearchSchema.parse({ requestId: 'request-a', ...raw });

    expect(parsed).toMatchObject({ pageSize: 50, requestId: 'request-a' });
    expect(parsed[field as keyof typeof parsed]).toBe(fallback);
  });

  test('resolves omitted URL dates at request time', () => {
    expect(resolveTraceSearch(traceSearchSchema.parse({ requestId: 'request-a' }), now)).toEqual({
      ...createDefaultTraceSearch(now),
      requestId: 'request-a',
    });
  });

  test('removes current-day date defaults when serializing URL state', () => {
    expect(
      toTraceUrlSearch(
        {
          ...createDefaultTraceSearch(now),
          requestId: 'request-a',
        },
        now,
      ),
    ).toEqual({ pageSize: 50, requestId: 'request-a' });
  });

  test('removes the page token and cleared values whenever filters change', () => {
    expect(
      withTraceFilters(
        {
          ...createDefaultTraceSearch(now),
          pageToken: 'next-page-token',
          requestId: 'request-a',
          sessionId: 'session-a',
        },
        { requestId: undefined, finalProviderId: 'provider-a' },
      ),
    ).toEqual({
      ...createDefaultTraceSearch(now),
      sessionId: 'session-a',
      finalProviderId: 'provider-a',
    });
  });
});
