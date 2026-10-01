import { expect, test } from 'bun:test';

import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';
import { attemptSpan, completion, rootSpan, rootStart } from '../trace-store.test-support';
import type { TraceStore } from '../types';

const NOW = new Date('2026-07-11T08:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Seed = {
  readonly id: number;
  readonly endedAt: Date;
  readonly model?: string;
  /** Attempts in order; `fail: true` marks a failed attempt. The last non-failed one is final. */
  readonly attempts: readonly { readonly provider: string; readonly fail?: boolean }[];
  readonly input?: number;
  readonly output?: number;
  readonly costUsd?: number;
};

function seed(store: TraceStore, s: Seed): void {
  const traceId = s.id.toString(16).padStart(32, '0');
  const spanId = s.id.toString(16).padStart(16, '0');
  const startedAt = new Date(s.endedAt.getTime() - 1_000);
  const model = s.model ?? 'model-a';
  const final = s.attempts.findLast((attempt) => attempt.fail !== true);
  const attributes = {
    'aio_proxy.request.id': `request-${s.id}`,
    'aio_proxy.protocol.inbound': 'openai-response',
    'gen_ai.request.model': model,
    ...(final === undefined
      ? {}
      : { 'aio_proxy.route.final_provider_id': final.provider, 'gen_ai.response.model': model }),
  };
  store.startRoot(rootStart({ traceId, spanId, requestId: `request-${s.id}`, startedAt, attributes }));
  const inference = rootSpan({
    traceId,
    spanId: s.id.toString(16).padStart(16, 'f'),
    parentSpanId: spanId,
    name: 'aio_proxy.inference',
    startedAt,
    endedAt: s.endedAt,
    attributes: { 'gen_ai.request.model': model },
  });
  const attempts = s.attempts.map((attempt, index) =>
    attemptSpan({
      traceId,
      spanId: `${s.id.toString(16)}${index.toString(16)}`.padStart(16, 'a'),
      parentSpanId: inference.spanId,
      name: `chat ${model}`,
      startedAt,
      endedAt: s.endedAt,
      statusCode: attempt.fail === true ? 2 : 0,
      attributes: {
        'aio_proxy.attempt.index': index,
        'aio_proxy.provider.id': attempt.provider,
        'aio_proxy.transport': 'ai_sdk',
        'aio_proxy.protocol.target': 'openai-response',
        ...(attempt.fail === true ? { 'aio_proxy.termination.reason': 'failure' } : {}),
      },
    }),
  );
  const usage =
    final === undefined
      ? undefined
      : {
          providerId: final.provider,
          modelId: model,
          inputTokens: s.input ?? 10,
          outputTokens: s.output ?? 5,
          estimatedCostUsd: s.costUsd ?? 0.001,
        };
  store.complete(
    completion({
      traceId,
      rootSpanId: spanId,
      spans: [rootSpan({ traceId, spanId, startedAt, endedAt: s.endedAt, attributes }), inference, ...attempts],
      summary:
        final === undefined
          ? { terminationReason: 'failure' }
          : { finalProviderId: final.provider, finalModelId: model, ...(usage === undefined ? {} : { usage }) },
    }),
  );
}

function withStore(run: (store: TraceStore) => void): void {
  const handle = openTestDb();
  try {
    run(createTraceStore(handle.db));
  } finally {
    handle.close();
  }
}

test('24h: totals, failures, the previous window, and 24 hourly buckets', () => {
  withStore((store) => {
    seed(store, {
      id: 1,
      endedAt: new Date(NOW.getTime() - HOUR),
      attempts: [{ provider: 'a' }],
      input: 100,
      output: 20,
    });
    seed(store, { id: 2, endedAt: new Date(NOW.getTime() - 2 * HOUR), attempts: [{ provider: 'a', fail: true }] });
    // One minute before the window starts: previous window only.
    seed(store, { id: 3, endedAt: new Date(NOW.getTime() - DAY - 60_000), attempts: [{ provider: 'b' }] });

    const usage = store.desktopUsage({ range: '24h', now: NOW });

    expect(usage.bucketUnit).toBe('hour');
    expect(usage.buckets).toHaveLength(24);
    expect(usage.current.requests).toBe('2');
    expect(usage.current.failedRequests).toBe('1');
    expect(usage.current.inputTokens).toBe('100');
    expect(usage.current.outputTokens).toBe('20');
    expect(usage.previous.requests).toBe('1');
    expect(usage.buckets.reduce((sum, bucket) => sum + Number(bucket.requests), 0)).toBe(2);
    expect(usage.rangeStart).toBe(new Date(NOW.getTime() - DAY).toISOString());
    expect(usage.rangeEnd).toBe(NOW.toISOString());
  });
});

test('a request that fails over from A to B counts once, under B', () => {
  withStore((store) => {
    seed(store, {
      id: 1,
      endedAt: new Date(NOW.getTime() - HOUR),
      attempts: [{ provider: 'a', fail: true }, { provider: 'b' }],
      input: 7,
      output: 3,
    });

    const { byProvider } = store.desktopUsage({ range: '24h', now: NOW });

    expect(byProvider).toEqual([
      { providerId: 'b', requests: '1', failedRequests: '0', totalTokens: '10', estimatedCostNanoUsd: '1000000' },
    ]);
  });
});

test('7d: day buckets, and the previous window is the 7 local days before', () => {
  withStore((store) => {
    seed(store, { id: 1, endedAt: new Date(NOW.getTime() - HOUR), attempts: [{ provider: 'a' }] });
    seed(store, { id: 2, endedAt: new Date(NOW.getTime() - 8 * DAY), attempts: [{ provider: 'a' }] });
    seed(store, { id: 3, endedAt: new Date(NOW.getTime() - 20 * DAY), attempts: [{ provider: 'a' }] });

    const usage = store.desktopUsage({ range: '7d', now: NOW });

    expect(usage.bucketUnit).toBe('day');
    expect(usage.buckets).toHaveLength(7);
    expect(usage.current.requests).toBe('1');
    expect(usage.previous.requests).toBe('1');
  });
});

test('byModel is ordered by cost then requests and capped at 20', () => {
  withStore((store) => {
    for (let index = 0; index < 22; index++) {
      seed(store, {
        id: index + 1,
        endedAt: new Date(NOW.getTime() - HOUR),
        model: `model-${String(index).padStart(2, '0')}`,
        attempts: [{ provider: 'a' }],
        costUsd: index === 5 ? 1 : 0.001,
      });
    }

    const { byModel } = store.desktopUsage({ range: '24h', now: NOW });

    expect(byModel).toHaveLength(20);
    expect(byModel[0]?.modelId).toBe('model-05');
  });
});
