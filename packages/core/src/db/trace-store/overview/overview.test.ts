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
  readonly terminationReason?: 'failure' | 'cancelled';
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
  let summary = finalProviderId === undefined ? { terminationReason: 'failure' as const } : { finalProviderId };
  if (seed.terminationReason !== undefined) summary = { terminationReason: seed.terminationReason };
  store.complete(
    completion({
      traceId,
      rootSpanId: spanId,
      spans: [rootSpan({ traceId, spanId, startedAt, endedAt, attributes: rootAttributes }), ...attempts],
      summary: {
        ...summary,
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

    const result = store.overviewDashboard({ range: '24h', now: NOW });

    expect(result.summary.current.cacheReadTokens).toBe('90');
    expect(result.summary.current.cacheWriteTokens).toBe('30');
    expect(result.summary.current.cacheHitRate).toBe(0.3);
    expect(result.summary.providerCount).toBe(0);
  });
});

test('returns null cache rate when no row establishes a positive prompt denominator', () => {
  withStore((store) => {
    seedTrace(store, { id: 1, attempts: [{ providerId: 'provider', durationMs: 10 }] });

    expect(store.overviewDashboard({ range: '24h', now: NOW }).summary.current.cacheHitRate).toBeNull();
  });
});

test('reports identical summary totals from per-request spans and the day rollup', () => {
  withStore((store) => {
    seedTrace(store, {
      id: 1,
      attempts: [{ providerId: 'ai', durationMs: 10, transport: 'ai_sdk' }],
      usage: { inputTokens: 100, totalTokens: 180, cacheReadTokens: 40, cacheWriteTokens: 10 },
    });
    seedTrace(store, {
      id: 2,
      attempts: [{ providerId: 'anthropic', durationMs: 10, transport: 'raw', targetProtocol: 'anthropic' }],
      usage: { inputTokens: 50, totalTokens: 90, cacheReadTokens: 30, cacheWriteTokens: 20, estimatedCostUsd: 3 },
    });
    seedTrace(store, { id: 3, attempts: [{ providerId: 'ai', durationMs: 10, outcome: 'failure' }] });
    seedTrace(store, { id: 4, attempts: [], terminationReason: 'cancelled' });

    const hot = store.overviewDashboard({ range: '24h', now: NOW }).summary.current;
    const rollup = store.overviewDashboard({ range: '7d', now: NOW }).summary.current;

    expect(rollup.requestCount).toBe(hot.requestCount);
    expect(rollup.totalTokens).toBe(hot.totalTokens);
    expect(rollup.inputTokens).toBe(hot.inputTokens);
    expect(rollup.outputTokens).toBe(hot.outputTokens);
    expect(rollup.cacheReadTokens).toBe(hot.cacheReadTokens);
    expect(rollup.cacheWriteTokens).toBe(hot.cacheWriteTokens);
    expect(rollup.estimatedCostNanoUsd).toBe(hot.estimatedCostNanoUsd);
    expect(rollup.cacheHitRate).toBe(hot.cacheHitRate);
    expect(hot.requestCount).toBe('4');
  });
});

test('keeps the longest range populated after trace pruning drops the underlying spans', () => {
  const handle = openTestDb();
  try {
    const store = createTraceStore(handle.db);
    const endedAt = new Date(NOW.getTime() - 50 * 24 * 60 * 60 * 1000);
    seedTrace(store, {
      id: 1,
      endedAt,
      modelId: 'retained-model',
      attempts: [{ providerId: 'provider', durationMs: 10 }],
      usage: { totalTokens: 400, estimatedCostUsd: 2 },
    });

    store.prune(new Date(NOW.getTime() - 45 * 24 * 60 * 60 * 1000), NOW);

    const longRange = store.overviewDashboard({ range: '90d', now: NOW }).summary.current;
    expect(longRange.requestCount).toBe('1');
    expect(longRange.totalTokens).toBe('400');
    expect(longRange.estimatedCostNanoUsd).toBe('2000000000');
    expect(store.overviewDashboard({ range: '24h', now: NOW }).summary.current.requestCount).toBe('0');
  } finally {
    handle.close();
  }
});

test('normalizes the day rollup cache rate by the same capture paths as the hot range', () => {
  withStore((store) => {
    seedTrace(store, {
      id: 1,
      attempts: [{ providerId: 'ai', durationMs: 10, transport: 'ai_sdk' }],
      usage: { inputTokens: 100, cacheReadTokens: 40, cacheWriteTokens: 10 },
    });
    seedTrace(store, {
      id: 2,
      attempts: [{ providerId: 'anthropic', durationMs: 10, transport: 'raw', targetProtocol: 'anthropic' }],
      usage: { inputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 20 },
    });
    seedTrace(store, {
      id: 3,
      attempts: [{ providerId: 'openai', durationMs: 10, transport: 'raw', targetProtocol: 'openai-compatible' }],
      usage: { inputTokens: 100, cacheReadTokens: 20 },
    });

    expect(store.overviewDashboard({ range: '7d', now: NOW }).summary.current.cacheHitRate).toBe(0.3);
  });
});

test('marks cache hit rate unavailable for rollups predating normalization', () => {
  const handle = openTestDb();
  try {
    const store = createTraceStore(handle.db);
    seedTrace(store, {
      id: 1,
      attempts: [{ providerId: 'provider', durationMs: 10 }],
      usage: { inputTokens: 100, cacheReadTokens: 50 },
    });
    handle.sqlite.run('UPDATE usage_daily SET cache_hit_rate_available = 0');
    seedTrace(store, {
      id: 2,
      attempts: [{ providerId: 'provider', durationMs: 10 }],
      usage: { inputTokens: 100, cacheReadTokens: 50 },
    });

    expect(store.overviewDashboard({ range: '7d', now: NOW }).summary.current.cacheHitRate).toBeNull();
  } finally {
    handle.close();
  }
});

test('keeps the previous day window disjoint from the current one', () => {
  withStore((store) => {
    // NOW is mid-day, so the 7d window is 07-05..07-11 and its baseline must stop
    // at 07-04. A millisecond-span shift would land mid-07-05 and round back up,
    // counting this trace in both periods.
    const firstDay = new Date(2026, 6, 5, 9, 0, 0);
    seedTrace(store, {
      id: 1,
      endedAt: firstDay,
      attempts: [{ providerId: 'provider', durationMs: 10 }],
      usage: { totalTokens: 100 },
    });

    const { current, previous } = store.overviewDashboard({ range: '7d', now: NOW }).summary;

    expect(current.requestCount).toBe('1');
    expect(previous.requestCount).toBe('0');
    expect(previous.totalTokens).toBe('0');
  });
});

test('averages request rate over the buckets that carry data, not the nominal window', () => {
  withStore((store) => {
    for (const id of [1, 2, 3]) {
      seedTrace(store, {
        id,
        attempts: [{ providerId: 'provider', durationMs: 10 }],
        usage: { totalTokens: 480 },
      });
    }

    const summary = store.overviewDashboard({ range: '30d', now: NOW }).summary.current;

    expect(summary.averageRpm).toBe(3 / 1_440);
    expect(summary.averageTpm).toBe(1_440 / 1_440);
  });
});

test('keeps the hot range aggregation free of all-time and yearly sections', () => {
  withStore((store) => {
    const result = store.overviewDashboard({ range: '24h', now: NOW });

    expect('providerHealth' in result).toBe(false);
    expect('topModelCosts' in result).toBe(false);
    expect('activity' in result).toBe(false);
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

    const result = store.overviewDashboard({ range: '24h', now: NOW });

    expect(result.modelTrendByMetric.requests.series.map(({ key }) => key)).toEqual(['a', 'b', 'c', 'd', '__other__']);
    expect(result.modelTrendByMetric.requests.buckets.every(({ values }) => !('__failed__' in values))).toBe(true);
    expect(result.modelTrendByMetric.requests.buckets.every(({ values }) => !('__cancelled__' in values))).toBe(true);
    expect(result.modelTrendByMetric.tokens.series.map(({ key }) => key)).toEqual(['e', 'd', 'c', 'b', '__other__']);
    expect(result.modelTrendByMetric.cost.series.map(({ key }) => key)).toEqual(['a', 'b', 'e', 'd', '__other__']);
    expect(store.overviewDashboardDiagnostics({ range: '24h', now: NOW }).topModelCosts).toEqual([
      { modelId: 'a', estimatedCostNanoUsd: '50' },
      { modelId: 'b', estimatedCostNanoUsd: '40' },
      { modelId: 'e', estimatedCostNanoUsd: '30' },
      { modelId: 'd', estimatedCostNanoUsd: '20' },
      { modelId: 'c', estimatedCostNanoUsd: '10' },
    ]);
  });
});

test('counts failed and cancelled roots in the request trend by requested model', () => {
  withStore((store) => {
    seedTrace(store, {
      id: 1,
      modelId: 'failed-model',
      attempts: [{ providerId: 'provider', durationMs: 10, outcome: 'failure' }],
    });
    seedTrace(store, {
      id: 2,
      modelId: 'cancelled-model',
      attempts: [],
      terminationReason: 'cancelled',
    });

    const result = store.overviewDashboard({ range: '24h', now: NOW });
    const requestTrendTotal = result.modelTrendByMetric.requests.buckets.reduce(
      (total, bucket) =>
        total + Object.values(bucket.values).reduce((bucketTotal, value) => bucketTotal + BigInt(value), 0n),
      0n,
    );

    expect(result.summary.current.requestCount).toBe('2');
    expect(result.modelTrendByMetric.requests.series.map(({ key }) => key)).toEqual([
      'cancelled-model',
      'failed-model',
    ]);
    expect(requestTrendTotal).toBe(2n);
    expect(result.modelTrendByMetric.requests.buckets.every(({ values }) => !('__failed__' in values))).toBe(true);
    expect(result.modelTrendByMetric.requests.buckets.every(({ values }) => !('__cancelled__' in values))).toBe(true);
  });
});

test('scopes Provider health and top model costs to the selected range', () => {
  withStore((store) => {
    seedTrace(store, {
      id: 1,
      endedAt: new Date(NOW.getTime() - 40 * 24 * 60 * 60 * 1000),
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

    const recent = store.overviewDashboardDiagnostics({ range: '24h', now: NOW });
    expect(recent.providerHealth).toEqual([{ providerId: 'recent-provider', successRate: 1, p95LatencyMs: 100 }]);
    expect(recent.topModelCosts).toEqual([{ modelId: 'recent-model', estimatedCostNanoUsd: '2000000000' }]);

    const quarter = store.overviewDashboardDiagnostics({ range: '90d', now: NOW });
    expect(quarter.providerHealth).toBeNull();
    expect(quarter.topModelCosts).toEqual([
      { modelId: 'old-model', estimatedCostNanoUsd: '5000000000' },
      { modelId: 'recent-model', estimatedCostNanoUsd: '2000000000' },
    ]);
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

    expect(store.overviewDashboardDiagnostics({ range: '24h', now: NOW }).providerHealth).toEqual([
      { providerId: 'a', successRate: 0, p95LatencyMs: 300 },
      { providerId: 'b', successRate: 1, p95LatencyMs: 900 },
      { providerId: 'c', successRate: 1, p95LatencyMs: 19 },
    ]);
  });
});

test('keeps rolling token activity after trace pruning', () => {
  const handle = openTestDb();
  try {
    const store = createTraceStore(handle.db);
    seedTrace(store, {
      id: 1,
      endedAt: new Date(2025, 0, 15, 12),
      modelId: 'retained-model',
      attempts: [{ providerId: 'provider', durationMs: 10 }],
      usage: { totalTokens: 123 },
    });

    store.prune(new Date(2025, 0, 16), new Date(2025, 0, 16));

    expect(store.find('00000000000000000000000000000001')).toBeUndefined();
    expect(
      store
        .overviewDashboardActivity({ now: new Date(2025, 0, 15, 12) })
        .items.find(({ date }) => date === '2025-01-15'),
    ).toEqual({
      date: '2025-01-15',
      totalTokens: '123',
      models: [{ modelId: 'retained-model', totalTokens: '123' }],
    });
  } finally {
    handle.close();
  }
});

test('keeps 90-day model costs after trace pruning and marks Provider health unavailable', () => {
  const handle = openTestDb();
  const now = new Date(2025, 0, 15, 12);
  try {
    const store = createTraceStore(handle.db);
    seedTrace(store, {
      id: 1,
      endedAt: now,
      modelId: 'pruned-model',
      attempts: [{ providerId: 'provider', durationMs: 10 }],
      usage: { estimatedCostUsd: 5 },
    });

    store.prune(new Date(2025, 0, 16), new Date(2025, 0, 16));

    expect(store.find('00000000000000000000000000000001')).toBeUndefined();
    expect(store.overviewDashboardDiagnostics({ range: '90d', now })).toEqual({
      providerHealth: null,
      topModelCosts: [{ modelId: 'pruned-model', estimatedCostNanoUsd: '5000000000' }],
    });
  } finally {
    handle.close();
  }
});

test('preserves totals above Number.MAX_SAFE_INTEGER', () => {
  withStore((store) => {
    for (const [index, totalTokens] of [4_503_599_627_370_496, 4_503_599_627_370_497].entries()) {
      seedTrace(store, {
        id: index + 1,
        attempts: [{ providerId: 'provider', durationMs: 10 }],
        usage: { totalTokens },
      });
    }

    expect(store.overviewDashboard({ range: '24h', now: NOW }).summary.current.totalTokens).toBe('9007199254740993');
  });
});

test('preserves range totals above the signed SQLite integer limit', () => {
  const handle = openTestDb();
  try {
    const store = createTraceStore(handle.db);
    for (const id of [1, 2]) {
      seedTrace(store, {
        id,
        modelId: 'large-model',
        attempts: [{ providerId: 'provider', durationMs: 10 }],
        usage: { totalTokens: 1, estimatedCostUsd: 0.000_000_001 },
      });
    }
    handle.sqlite
      .query(`update trace_span set
        input_tokens = ?, output_tokens = ?, total_tokens = null,
        cache_read_tokens = ?, cache_write_tokens = ?, estimated_cost_nano_usd = ?
        where parent_span_id is null`)
      .run(
        5_000_000_000_000_000_000n,
        5_000_000_000_000_000_000n,
        5_000_000_000_000_000_000n,
        5_000_000_000_000_000_000n,
        5_000_000_000_000_000_000n,
      );

    const overview = store.overviewDashboard({ range: '24h', now: NOW });

    expect(overview.summary.current.totalTokens).toBe('20000000000000000000');
    expect(overview.summary.current.cacheReadTokens).toBe('10000000000000000000');
    expect(overview.summary.current.cacheWriteTokens).toBe('10000000000000000000');
    expect(overview.summary.current.estimatedCostNanoUsd).toBe('10000000000000000000');
    expect(overview.summary.current.cacheHitRate).toBe(0.5);
    expect(overview.modelTrendByMetric.tokens.buckets.find(({ values }) => values['large-model'] !== '0')).toEqual({
      key: '2026-07-11T07:00:00.000Z',
      values: { 'large-model': '20000000000000000000' },
    });
    expect(overview.modelTrendByMetric.cost.buckets.find(({ values }) => values['large-model'] !== '0')).toEqual({
      key: '2026-07-11T07:00:00.000Z',
      values: { 'large-model': '10000000000000000000' },
    });
  } finally {
    handle.close();
  }
});

test('returns a Sunday-aligned rolling 52-week window with empty days', () => {
  withStore((store) => {
    const activity = store.overviewDashboardActivity({ now: new Date(2026, 7, 5) });

    expect(activity.from).toBe('2025-08-10');
    expect(activity.to).toBe('2026-08-05');
    expect(activity.items).toHaveLength(361);
    expect(activity.items[0]).toEqual({ date: '2025-08-10', totalTokens: '0', models: [] });
    expect(activity.items.at(-1)).toEqual({ date: '2026-08-05', totalTokens: '0', models: [] });
  });
});

test('groups daily token activity by model and materializes missing days', () => {
  withStore((store) => {
    seedTrace(store, {
      id: 1,
      endedAt: new Date(2025, 7, 10, 12),
      modelId: 'small-model',
      attempts: [{ providerId: 'provider', durationMs: 10 }],
      usage: { totalTokens: 100 },
    });
    seedTrace(store, {
      id: 2,
      endedAt: new Date(2025, 7, 10, 12),
      modelId: 'large-model',
      attempts: [{ providerId: 'provider', durationMs: 10 }],
      usage: { totalTokens: 250 },
    });
    seedTrace(store, {
      id: 3,
      endedAt: new Date(2025, 7, 10, 12),
      modelId: 'zero-model',
      attempts: [{ providerId: 'provider', durationMs: 10 }],
      usage: { totalTokens: 0 },
    });
    seedTrace(store, {
      id: 4,
      endedAt: new Date(2025, 7, 12, 12),
      modelId: 'other-model',
      attempts: [{ providerId: 'provider', durationMs: 10 }],
      usage: { totalTokens: 50 },
    });

    const activity = store.overviewDashboardActivity({ now: new Date(2026, 7, 5) });

    expect(activity.items.find(({ date }) => date === '2025-08-10')).toEqual({
      date: '2025-08-10',
      totalTokens: '350',
      models: [
        { modelId: 'large-model', totalTokens: '250' },
        { modelId: 'small-model', totalTokens: '100' },
      ],
    });
    expect(activity.items.find(({ date }) => date === '2025-08-11')).toEqual({
      date: '2025-08-11',
      totalTokens: '0',
      models: [],
    });
    expect(activity.items.find(({ date }) => date === '2025-08-12')).toEqual({
      date: '2025-08-12',
      totalTokens: '50',
      models: [{ modelId: 'other-model', totalTokens: '50' }],
    });
  });
});
