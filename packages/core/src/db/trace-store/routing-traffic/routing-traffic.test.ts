import { expect, test } from 'bun:test';

import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';
import { attemptSpan, completion, rootSpan, rootStart } from '../trace-store.test-support';
import type { StoredSpan, TraceStore } from '../types';

const NOW = new Date('2026-09-25T08:00:00.000Z');

type AttemptSeed = {
  readonly providerId: string;
  readonly durationMs: number;
  readonly outcome?: 'success' | 'failure';
};

type TraceSeed = {
  readonly id: number;
  readonly requestedModelId: string;
  readonly attempts: readonly AttemptSeed[];
  readonly endedAt?: Date;
  /** Overrides the final owner. Used to build a root-only trace with no attempt spans. */
  readonly finalProviderId?: string;
};

function seedTrace(store: TraceStore, seed: TraceSeed): void {
  const traceId = seed.id.toString(16).padStart(32, '0');
  const spanId = seed.id.toString(16).padStart(16, '0');
  const endedAt = seed.endedAt ?? NOW;
  const startedAt = new Date(endedAt.getTime() - 1_000);
  const finalProviderId =
    seed.finalProviderId ?? seed.attempts.findLast(({ outcome }) => outcome !== 'failure')?.providerId;
  const attributes = {
    'aio_proxy.request.id': `request-${seed.id}`,
    'aio_proxy.protocol.inbound': 'openai-response',
    'gen_ai.request.model': seed.requestedModelId,
    ...(finalProviderId === undefined
      ? {}
      : { 'aio_proxy.route.final_provider_id': finalProviderId, 'gen_ai.response.model': seed.requestedModelId }),
  };
  store.startRoot(rootStart({ traceId, spanId, requestId: `request-${seed.id}`, startedAt, attributes }));
  const inference = rootSpan({
    traceId,
    spanId: seed.id.toString(16).padStart(16, 'f'),
    parentSpanId: spanId,
    name: 'aio_proxy.inference',
    startedAt,
    endedAt,
    // request_id is globally unique, so only the root span may carry aio_proxy.request.id.
    attributes: { 'gen_ai.request.model': seed.requestedModelId },
  });
  const attempts: StoredSpan[] = seed.attempts.map((attempt, index) => {
    const failed = attempt.outcome === 'failure';
    return attemptSpan({
      traceId,
      // Attempts hang off the inference span, not the root: the aggregation can only join on trace_id.
      parentSpanId: inference.spanId,
      spanId: `${seed.id.toString(16)}${index.toString(16)}`.padStart(16, 'a'),
      startedAt: new Date(endedAt.getTime() - attempt.durationMs),
      endedAt,
      statusCode: failed ? 2 : 0,
      attributes: {
        'aio_proxy.attempt.index': index,
        'aio_proxy.provider.id': attempt.providerId,
        ...(failed ? { 'aio_proxy.termination.reason': 'failure' } : {}),
      },
    });
  });
  store.complete(
    completion({
      traceId,
      rootSpanId: spanId,
      spans: [rootSpan({ traceId, spanId, startedAt, endedAt, attributes }), inference, ...attempts],
      summary:
        finalProviderId === undefined
          ? { terminationReason: 'failure' as const }
          : { finalProviderId, finalModelId: seed.requestedModelId },
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

test('separates attempts from final ownership so a failed-over Provider keeps its failure rate', () => {
  withStore((store) => {
    // primary fails both times and fails over to fallback; fallback succeeds both times.
    seedTrace(store, {
      id: 1,
      requestedModelId: 'anthropic/claude-sonnet-4.5',
      attempts: [
        { providerId: 'primary', durationMs: 50, outcome: 'failure' },
        { providerId: 'fallback', durationMs: 80 },
      ],
    });
    seedTrace(store, {
      id: 2,
      requestedModelId: 'anthropic/claude-sonnet-4.5',
      attempts: [
        { providerId: 'primary', durationMs: 60, outcome: 'failure' },
        { providerId: 'fallback', durationMs: 90 },
      ],
    });

    const traffic = store.routingTraffic({ range: '24h', now: NOW });
    const model = traffic.models.find(({ modelId }) => modelId === 'anthropic/claude-sonnet-4.5');
    const byId = new Map(model?.providers.map((entry) => [entry.providerId, entry]));

    // The actual-share numerator only counts who finally served the request: primary never did.
    expect(byId.get('primary')).toMatchObject({ finalCount: '0', attemptCount: '2', successCount: '0' });
    expect(byId.get('fallback')).toMatchObject({ finalCount: '2', attemptCount: '2', successCount: '2' });
    expect(byId.get('primary')?.p95LatencyMs).toBeGreaterThan(0);
  });
});

test('reports a null p95 and omits traces whose window falls outside the range', () => {
  withStore((store) => {
    seedTrace(store, {
      id: 3,
      requestedModelId: 'gpt-5-codex',
      attempts: [{ providerId: 'primary', durationMs: 10 }],
      endedAt: new Date(NOW.getTime() - 48 * 60 * 60 * 1000),
    });

    expect(store.routingTraffic({ range: '24h', now: NOW }).models).toEqual([]);
    expect(
      store.routingTraffic({ range: '7d', now: NOW }).models.find(({ modelId }) => modelId === 'gpt-5-codex'),
    ).toBeDefined();
  });
});

test('counts a root-only trace toward final ownership while leaving attempt metrics empty', () => {
  withStore((store) => {
    // A trace with no attempt spans (abnormal, but possible): primary really did serve it, so it
    // must count toward finalCount or the actual share is undercounted — and the actual share is
    // this page's headline number. attemptCount / successCount are attempt-level metrics and stay
    // empty here; p95 is null rather than 0. That makes successCount and finalCount disagree in
    // this one case: consumers must compute the success rate as successCount / attemptCount and
    // never divide by finalCount.
    seedTrace(store, { id: 5, requestedModelId: 'gpt-5-codex', attempts: [], finalProviderId: 'primary' });

    const model = store
      .routingTraffic({ range: '24h', now: NOW })
      .models.find(({ modelId }) => modelId === 'gpt-5-codex');

    expect(model?.providers).toEqual([
      { providerId: 'primary', finalCount: '1', attemptCount: '0', successCount: '0', p95LatencyMs: null },
    ]);
  });
});

test('buckets one model densely by Provider', () => {
  withStore((store) => {
    seedTrace(store, {
      id: 4,
      requestedModelId: 'anthropic/claude-sonnet-4.5',
      attempts: [{ providerId: 'fallback', durationMs: 30 }],
    });

    const buckets = store.routingTrafficBuckets({
      range: '24h',
      modelId: 'anthropic/claude-sonnet-4.5',
      now: NOW,
    });

    expect(buckets.bucketUnit).toBe('hour');
    expect(buckets.buckets).toHaveLength(24);
    expect(buckets.providerIds).toEqual(['fallback']);
    expect(buckets.buckets.some(({ values }) => values['fallback'] === '1')).toBe(true);
    // Empty buckets must exist and read 0, otherwise the chart shows a gap.
    expect(buckets.buckets.every(({ values }) => typeof values['fallback'] === 'string')).toBe(true);
  });
});
