import { expect, test } from 'bun:test';

import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';
import { attemptSpan, completion, rootSpan, rootStart } from '../trace-store.test-support';
import type { StoredSpan, TraceStore } from '../types';

const NOW = new Date('2026-07-11T08:00:00.000Z');

type AttemptSeed = {
  readonly providerId: string;
  readonly durationMs: number;
  readonly outcome?: 'success' | 'failure';
  readonly transport?: 'raw' | 'ai_sdk';
  readonly targetProtocol?: 'openai-response' | 'openai-compatible' | 'anthropic' | 'gemini';
};

type TraceSeed = {
  readonly id: number;
  readonly endedAt?: Date;
  readonly modelId?: string;
  readonly attempts: readonly AttemptSeed[];
  readonly usage?: {
    readonly inputTokens?: number;
    readonly totalTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
    readonly estimatedCostUsd?: number;
  };
};

function seedTrace(store: TraceStore, seed: TraceSeed): void {
  const traceId = seed.id.toString(16).padStart(32, '0');
  const spanId = seed.id.toString(16).padStart(16, '0');
  const endedAt = seed.endedAt ?? NOW;
  const startedAt = new Date(endedAt.getTime() - 1_000);
  const finalAttempt = seed.attempts.findLast(({ outcome }) => outcome !== 'failure');
  const finalProviderId = finalAttempt?.providerId;
  const finalModelId = seed.modelId ?? 'model';
  const rootAttributes = {
    'aio_proxy.request.id': `request-${seed.id}`,
    'aio_proxy.protocol.inbound': 'openai-response',
    'gen_ai.request.model': finalModelId,
    ...(finalProviderId === undefined ? {} : { 'aio_proxy.route.final_provider_id': finalProviderId }),
    ...(finalProviderId === undefined ? {} : { 'gen_ai.response.model': finalModelId }),
  };
  store.startRoot(
    rootStart({
      traceId,
      spanId,
      requestId: `request-${seed.id}`,
      startedAt,
      attributes: rootAttributes,
    }),
  );
  const attempts: StoredSpan[] = seed.attempts.map((attempt, index) => {
    const failed = attempt.outcome === 'failure';
    return attemptSpan({
      traceId,
      spanId: `${seed.id.toString(16)}${index.toString(16)}`.padStart(16, 'a'),
      parentSpanId: spanId,
      startedAt: new Date(endedAt.getTime() - attempt.durationMs),
      endedAt,
      statusCode: failed ? 2 : 0,
      attributes: {
        'aio_proxy.attempt.index': index,
        'aio_proxy.provider.id': attempt.providerId,
        'aio_proxy.transport': attempt.transport ?? 'ai_sdk',
        'aio_proxy.protocol.target': attempt.targetProtocol ?? 'openai-response',
        ...(failed ? { 'aio_proxy.termination.reason': 'failure' } : {}),
      },
    });
  });
  const usage =
    seed.usage === undefined || finalProviderId === undefined
      ? undefined
      : { providerId: finalProviderId, modelId: finalModelId, ...seed.usage };
  store.complete(
    completion({
      traceId,
      rootSpanId: spanId,
      spans: [rootSpan({ traceId, spanId, startedAt, endedAt, attributes: rootAttributes }), ...attempts],
      summary: {
        ...(finalProviderId === undefined ? { terminationReason: 'failure' as const } : { finalProviderId }),
        ...(finalProviderId === undefined ? {} : { finalModelId }),
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

test('normalizes inclusive and additive cache accounting by the successful capture path', () => {
  withStore((store) => {
    seedTrace(store, {
      id: 1,
      attempts: [{ providerId: 'ai', durationMs: 10, transport: 'ai_sdk' }],
      usage: { inputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 10 },
    });
    seedTrace(store, {
      id: 2,
      attempts: [
        {
          providerId: 'anthropic',
          durationMs: 10,
          transport: 'raw',
          targetProtocol: 'anthropic',
        },
      ],
      usage: { inputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 20 },
    });
    seedTrace(store, {
      id: 3,
      attempts: [
        {
          providerId: 'openai',
          durationMs: 10,
          transport: 'raw',
          targetProtocol: 'openai-compatible',
        },
      ],
      usage: { inputTokens: 100, cacheReadTokens: 20 },
    });

    const result = store.overviewDashboard({ range: '24h', year: 2026, now: NOW });

    expect(result.summary.cacheReadTokens).toBe('90');
    expect(result.summary.cacheWriteTokens).toBe('30');
    expect(result.summary.cacheHitRate).toBe(0.3);
    expect(result.summary.providerCount).toBe(0);
  });
});

test('returns null cache rate when no row establishes a positive prompt denominator', () => {
  withStore((store) => {
    seedTrace(store, { id: 1, attempts: [{ providerId: 'provider', durationMs: 10 }] });

    expect(store.overviewDashboard({ range: '24h', year: 2026, now: NOW }).summary.cacheHitRate).toBeNull();
  });
});

test('ranks Top 4 plus Other independently for requests, tokens, and cost', () => {
  withStore((store) => {
    const rows = [
      ['a', 10, 50],
      ['b', 20, 40],
      ['c', 30, 10],
      ['d', 40, 20],
      ['e', 50, 30],
    ] as const;
    for (const [index, [modelId, totalTokens, costNanoUsd]] of rows.entries()) {
      seedTrace(store, {
        id: index + 1,
        modelId,
        attempts: [{ providerId: 'provider', durationMs: 10 }],
        usage: { totalTokens, estimatedCostUsd: costNanoUsd / 1_000_000_000 },
      });
    }

    const result = store.overviewDashboard({ range: '24h', year: 2026, now: NOW });

    expect(result.modelTrendByMetric.requests.series.map(({ key }) => key)).toEqual(['a', 'b', 'c', 'd', '__other__']);
    expect(result.modelTrendByMetric.requests.buckets.every(({ values }) => !('__failed__' in values))).toBe(true);
    expect(result.modelTrendByMetric.requests.buckets.every(({ values }) => !('__cancelled__' in values))).toBe(true);
    expect(result.modelTrendByMetric.tokens.series.map(({ key }) => key)).toEqual(['e', 'd', 'c', 'b', '__other__']);
    expect(result.modelTrendByMetric.cost.series.map(({ key }) => key)).toEqual(['a', 'b', 'e', 'd', '__other__']);
    expect(result.topModelCosts).toEqual([
      { modelId: 'a', estimatedCostNanoUsd: '50' },
      { modelId: 'b', estimatedCostNanoUsd: '40' },
      { modelId: 'e', estimatedCostNanoUsd: '30' },
      { modelId: 'd', estimatedCostNanoUsd: '20' },
      { modelId: 'c', estimatedCostNanoUsd: '10' },
    ]);
  });
});

test('keeps Provider health and top model costs independent of range and activity year', () => {
  withStore((store) => {
    seedTrace(store, {
      id: 1,
      endedAt: new Date('2025-01-15T08:00:00.000Z'),
      modelId: 'old-model',
      attempts: [{ providerId: 'old-provider', durationMs: 700 }],
      usage: { estimatedCostUsd: 5 },
    });
    seedTrace(store, {
      id: 2,
      modelId: 'recent-model',
      attempts: [{ providerId: 'recent-provider', durationMs: 100 }],
      usage: { estimatedCostUsd: 2 },
    });

    const narrow = store.overviewDashboard({ range: '24h', year: 2026, now: NOW });
    const changed = store.overviewDashboard({ range: '90d', year: 2025, now: NOW });

    const expectedHealth = [
      { providerId: 'old-provider', successRate: 1, p95LatencyMs: 700 },
      { providerId: 'recent-provider', successRate: 1, p95LatencyMs: 100 },
    ];
    const expectedCosts = [
      { modelId: 'old-model', estimatedCostNanoUsd: '5000000000' },
      { modelId: 'recent-model', estimatedCostNanoUsd: '2000000000' },
    ];
    expect(narrow.providerHealth).toEqual(expectedHealth);
    expect(changed.providerHealth).toEqual(expectedHealth);
    expect(narrow.topModelCosts).toEqual(expectedCosts);
    expect(changed.topModelCosts).toEqual(expectedCosts);
  });
});

test('derives Provider health from failed and successful attempt child spans', () => {
  withStore((store) => {
    seedTrace(store, {
      id: 1,
      attempts: [
        { providerId: 'a', durationMs: 300, outcome: 'failure' },
        { providerId: 'b', durationMs: 900 },
      ],
    });
    for (let durationMs = 1; durationMs <= 20; durationMs += 1) {
      seedTrace(store, { id: durationMs + 1, attempts: [{ providerId: 'c', durationMs }] });
    }

    expect(store.overviewDashboard({ range: '24h', year: 2026, now: NOW }).providerHealth).toEqual([
      { providerId: 'a', successRate: 0, p95LatencyMs: 300 },
      { providerId: 'b', successRate: 1, p95LatencyMs: 900 },
      { providerId: 'c', successRate: 1, p95LatencyMs: 19 },
    ]);
  });
});

test('preserves SQL sums above Number.MAX_SAFE_INTEGER', () => {
  withStore((store) => {
    for (const [index, totalTokens] of [4_503_599_627_370_496, 4_503_599_627_370_497].entries()) {
      seedTrace(store, {
        id: index + 1,
        attempts: [{ providerId: 'provider', durationMs: 10 }],
        usage: { totalTokens },
      });
    }

    expect(store.overviewDashboard({ range: '24h', year: 2026, now: NOW }).summary.totalTokens).toBe(
      '9007199254740993',
    );
  });
});

test('materializes empty common years and every leap-year boundary date', () => {
  withStore((store) => {
    const empty = store.overviewDashboard({ range: '24h', year: 2025, now: NOW }).activity;
    expect(empty.days).toHaveLength(365);
    expect(empty.days[0]).toEqual({ date: '2025-01-01', requestCount: '0' });
    expect(empty.days.at(-1)).toEqual({ date: '2025-12-31', requestCount: '0' });

    seedTrace(store, {
      id: 1,
      endedAt: new Date(2024, 0, 1, 12),
      attempts: [{ providerId: 'provider', durationMs: 10 }],
    });
    seedTrace(store, {
      id: 2,
      endedAt: new Date(2024, 11, 31, 12),
      attempts: [{ providerId: 'provider', durationMs: 10 }],
    });
    const leap = store.overviewDashboard({ range: '24h', year: 2024, now: NOW }).activity;

    expect(leap.days).toHaveLength(366);
    expect(leap.days[0]).toEqual({ date: '2024-01-01', requestCount: '1' });
    expect(leap.days.at(-1)).toEqual({ date: '2024-12-31', requestCount: '1' });
  });
});
