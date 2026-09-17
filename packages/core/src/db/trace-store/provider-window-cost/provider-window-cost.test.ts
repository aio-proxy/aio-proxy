import { describe, expect, test } from 'bun:test';

import { traceSpan } from '../../schema';
import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';
import { completion, rootSpan, rootStart } from '../trace-store.test-support';
import type { TraceCompletion } from '../types';

const START = new Date('2026-07-24T10:00:00.000Z');
const MID = new Date('2026-07-24T12:00:00.000Z');
const END = new Date('2026-07-24T14:00:00.000Z');

function makeStore() {
  const handle = openTestDb();
  return { handle, store: createTraceStore(handle.db) };
}

function complete(
  store: ReturnType<typeof createTraceStore>,
  traceId: string,
  endedAt: Date,
  summary: TraceCompletion['summary'],
): void {
  const spanId = traceId.slice(0, 16);
  const attrs: Record<string, unknown> = { 'aio_proxy.protocol.inbound': 'openai-compatible' };
  if (summary.finalProviderId !== undefined) attrs['aio_proxy.route.final_provider_id'] = summary.finalProviderId;
  if (summary.finalModelId !== undefined) attrs['gen_ai.response.model'] = summary.finalModelId;
  if (summary.usage?.estimatedCostUsd !== undefined)
    attrs['gen_ai.usage.estimated_cost_usd'] = summary.usage.estimatedCostUsd;
  store.startRoot(rootStart({ traceId, spanId, requestId: `req-${traceId}`, startedAt: START, attributes: attrs }));
  store.complete(
    completion({
      traceId,
      rootSpanId: spanId,
      spans: [rootSpan({ traceId, spanId, startedAt: START, endedAt, attributes: attrs })],
      summary,
    }),
  );
}

describe('providerWindowCost', () => {
  test('sums successful priced roots for this Provider in the window', () => {
    const { handle, store } = makeStore();
    try {
      complete(store, 'a'.repeat(32), MID, {
        finalProviderId: 'person',
        finalModelId: 'gpt-5',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'gpt-5', estimatedCostUsd: 0.1 },
      });
      complete(store, 'b'.repeat(32), MID, {
        finalProviderId: 'person',
        finalModelId: 'codex-auto-review',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'codex-auto-review', estimatedCostUsd: 0.2 },
      });
      complete(store, 'c'.repeat(32), MID, {
        finalProviderId: 'other',
        finalModelId: 'gpt-5',
        finalHttpStatus: 200,
        usage: { providerId: 'other', modelId: 'gpt-5', estimatedCostUsd: 9 },
      });

      expect(store.providerWindowCost({ providerId: 'person', start: START, end: END })).toBe('300000000');
    } finally {
      handle.close();
    }
  });

  test('returns undefined when nothing priced matched, not zero', () => {
    const { handle, store } = makeStore();
    try {
      complete(store, 'a'.repeat(32), MID, {
        finalProviderId: 'person',
        finalModelId: 'gpt-5',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'gpt-5', totalTokens: 10 },
      });
      store.startRoot(rootStart({ traceId: 'd'.repeat(32), spanId: 'd'.repeat(16), requestId: 'running' }));

      expect(store.providerWindowCost({ providerId: 'person', start: START, end: END })).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  test('excludes priced failed, cancelled, and interrupted roots for this Provider', () => {
    const { handle, store } = makeStore();
    try {
      for (const [traceId, terminationReason] of [
        ['a'.repeat(32), 'failure'],
        ['b'.repeat(32), 'cancelled'],
        ['c'.repeat(32), 'interrupted'],
      ] as const) {
        handle.db
          .insert(traceSpan)
          .values({
            traceId,
            spanId: traceId.slice(0, 16),
            name: 'aio_proxy.request',
            kind: 1,
            startedAt: START,
            endedAt: MID,
            statusCode: terminationReason === 'failure' ? 2 : 0,
            terminationReason,
            finalProviderId: 'person',
            finalModelId: 'gpt-5',
            estimatedCostNanoUsd: 400_000_000,
            attributes: {},
            events: [],
            links: [],
          })
          .run();
      }

      expect(store.providerWindowCost({ providerId: 'person', start: START, end: END })).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  test('a real priced sum of zero is not treated as missing', () => {
    const { handle, store } = makeStore();
    try {
      handle.db
        .insert(traceSpan)
        .values({
          traceId: '0'.repeat(32),
          spanId: 'f'.repeat(16),
          name: 'aio_proxy.request',
          kind: 1,
          startedAt: START,
          endedAt: MID,
          statusCode: 0,
          finalProviderId: 'person',
          estimatedCostNanoUsd: 0,
          attributes: {},
          events: [],
          links: [],
        })
        .run();

      expect(store.providerWindowCost({ providerId: 'person', start: START, end: END })).toBe('0');
    } finally {
      handle.close();
    }
  });

  test('excludes endedAt outside the inclusive window and ignores child spans', () => {
    const { handle, store } = makeStore();
    try {
      complete(store, 'a'.repeat(32), new Date(START.getTime() - 1), {
        finalProviderId: 'person',
        finalModelId: 'gpt-5',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'gpt-5', estimatedCostUsd: 0.1 },
      });
      complete(store, 'b'.repeat(32), new Date(END.getTime() + 1), {
        finalProviderId: 'person',
        finalModelId: 'gpt-5',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'gpt-5', estimatedCostUsd: 0.1 },
      });
      complete(store, 'c'.repeat(32), START, {
        finalProviderId: 'person',
        finalModelId: 'gpt-5',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'gpt-5', estimatedCostUsd: 0.05 },
      });
      complete(store, 'e'.repeat(32), END, {
        finalProviderId: 'person',
        finalModelId: 'gpt-5',
        finalHttpStatus: 200,
        usage: { providerId: 'person', modelId: 'gpt-5', estimatedCostUsd: 0.05 },
      });
      handle.db
        .insert(traceSpan)
        .values({
          traceId: 'c'.repeat(32),
          spanId: '1'.repeat(16),
          parentSpanId: 'c'.repeat(16),
          name: 'aio_proxy.provider.attempt',
          kind: 2,
          startedAt: START,
          endedAt: START,
          statusCode: 0,
          finalProviderId: 'person',
          estimatedCostNanoUsd: 9_000_000_000,
          attributes: {},
          events: [],
          links: [],
        })
        .run();

      expect(store.providerWindowCost({ providerId: 'person', start: START, end: END })).toBe('100000000');
    } finally {
      handle.close();
    }
  });
});
