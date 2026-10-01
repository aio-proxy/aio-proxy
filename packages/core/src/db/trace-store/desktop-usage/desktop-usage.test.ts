import { expect, test } from 'bun:test';

import { createTraceStore } from '../index';
import { bucketKeys, resolveRange } from '../overview';
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
  /** `unpriced` records tokens without a cost; `none` records no usage at all. Default: priced. */
  readonly pricing?: 'unpriced' | 'none';
  /** A terminal reason on a request that still reached its final Provider. */
  readonly termination?: 'failure' | 'cancelled';
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
    final === undefined || s.pricing === 'none'
      ? undefined
      : {
          providerId: final.provider,
          modelId: model,
          inputTokens: s.input ?? 10,
          outputTokens: s.output ?? 5,
          ...(s.pricing === 'unpriced' ? {} : { estimatedCostUsd: s.costUsd ?? 0.001 }),
        };
  store.complete(
    completion({
      traceId,
      rootSpanId: spanId,
      spans: [rootSpan({ traceId, spanId, startedAt, endedAt: s.endedAt, attributes }), inference, ...attempts],
      summary:
        final === undefined
          ? { terminationReason: 'failure' }
          : {
              finalProviderId: final.provider,
              finalModelId: model,
              ...(s.termination === undefined ? {} : { terminationReason: s.termination }),
              ...(usage === undefined ? {} : { usage }),
            },
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

test('7d: a request three days back lands in its day bucket and its failure is counted there', () => {
  withStore((store) => {
    seed(store, { id: 1, endedAt: new Date(NOW.getTime() - 3 * DAY), attempts: [{ provider: 'a', fail: true }] });

    const usage = store.desktopUsage({ range: '7d', now: NOW });

    const range = resolveRange('7d', NOW);
    const keys = bucketKeys('7d', range.start, range.end);
    const expected = keys.at(-4)?.key;
    const hit = usage.buckets.filter((bucket) => bucket.requests !== '0');
    expect(hit).toHaveLength(1);
    expect(hit[0]?.start).toBe(expected);
    expect(hit[0]?.failedRequests).toBe('1');
    expect(usage.current.failedRequests).toBe('1');
  });
});

test('a cancelled request counts as a request but not as a failure', () => {
  withStore((store) => {
    seed(store, {
      id: 1,
      endedAt: new Date(NOW.getTime() - HOUR),
      attempts: [{ provider: 'a' }],
      termination: 'cancelled',
      pricing: 'none',
    });

    const usage = store.desktopUsage({ range: '24h', now: NOW });

    expect(usage.current.requests).toBe('1');
    expect(usage.current.failedRequests).toBe('0');
    expect(usage.byProvider[0]?.failedRequests).toBe('0');
  });
});

test('pricingCoverage is priced over with-usage requests, and null without any usage', () => {
  withStore((store) => {
    expect(store.desktopUsage({ range: '24h', now: NOW }).current.pricingCoverage).toBeNull();

    seed(store, { id: 1, endedAt: new Date(NOW.getTime() - HOUR), attempts: [{ provider: 'a' }] });
    seed(store, { id: 2, endedAt: new Date(NOW.getTime() - HOUR), attempts: [{ provider: 'a' }], pricing: 'unpriced' });
    seed(store, { id: 3, endedAt: new Date(NOW.getTime() - HOUR), attempts: [{ provider: 'a' }], pricing: 'none' });

    expect(store.desktopUsage({ range: '24h', now: NOW }).current.pricingCoverage).toBe(0.5);
  });
  withStore((store) => {
    seed(store, { id: 1, endedAt: new Date(NOW.getTime() - HOUR), attempts: [{ provider: 'a' }], pricing: 'none' });

    expect(store.desktopUsage({ range: '24h', now: NOW }).current.pricingCoverage).toBeNull();
  });
});

test('byProvider counts a request that failed on its final Provider as a failure', () => {
  withStore((store) => {
    seed(store, {
      id: 1,
      endedAt: new Date(NOW.getTime() - HOUR),
      attempts: [{ provider: 'a' }],
      termination: 'failure',
      pricing: 'none',
    });

    expect(store.desktopUsage({ range: '24h', now: NOW }).byProvider).toEqual([
      { providerId: 'a', requests: '1', failedRequests: '1', totalTokens: '0', estimatedCostNanoUsd: '0' },
    ]);
  });
});

test('24h previous window totals mix success, failure, cancelled, priced, unpriced and no usage', () => {
  withStore((store) => {
    const at = new Date(NOW.getTime() - DAY - 2 * HOUR);
    seed(store, { id: 1, endedAt: at, attempts: [{ provider: 'a' }], input: 100, output: 20 });
    seed(store, { id: 2, endedAt: at, attempts: [{ provider: 'a' }], input: 5, output: 5, pricing: 'unpriced' });
    seed(store, { id: 3, endedAt: at, attempts: [{ provider: 'a', fail: true }] });
    seed(store, { id: 4, endedAt: at, attempts: [{ provider: 'a' }], termination: 'cancelled', pricing: 'none' });
    seed(store, { id: 5, endedAt: at, attempts: [{ provider: 'a' }], pricing: 'none' });
    // Outside the previous window on both sides.
    seed(store, { id: 6, endedAt: new Date(NOW.getTime() - 2 * DAY - 60_000), attempts: [{ provider: 'a' }] });
    seed(store, { id: 7, endedAt: new Date(NOW.getTime() - HOUR), attempts: [{ provider: 'a' }] });

    const { previous } = store.desktopUsage({ range: '24h', now: NOW });

    expect(previous).toEqual({
      requests: '5',
      failedRequests: '1',
      inputTokens: '105',
      outputTokens: '25',
      estimatedCostNanoUsd: '1000000',
      pricingCoverage: 0.5,
    });
  });
});

test('entries tied on cost and requests are ordered by name', () => {
  withStore((store) => {
    for (const [id, model] of [
      [1, 'model-b'],
      [2, 'model-a'],
      [3, 'model-c'],
    ] as const) {
      seed(store, {
        id,
        endedAt: new Date(NOW.getTime() - HOUR),
        model,
        attempts: [{ provider: `p${(id % 3) + 1}` }],
      });
    }

    const usage = store.desktopUsage({ range: '24h', now: NOW });

    expect(usage.byModel.map((entry) => entry.modelId)).toEqual(['model-a', 'model-b', 'model-c']);
    expect(usage.byProvider.map((entry) => entry.providerId)).toEqual(['p1', 'p2', 'p3']);
  });
});
