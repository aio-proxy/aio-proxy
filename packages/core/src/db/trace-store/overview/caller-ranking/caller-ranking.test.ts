import { expect, test } from 'bun:test';

import { createTraceStore, openDb } from '../../../index';
import { openTestDb, tempHome } from '../../test-support';
import { attemptSpan, completion, rootSpan, rootStart } from '../../trace-store.test-support';
import type { TraceStore } from '../../types';

const now = new Date('2026-10-09T12:00:00Z');

function seed(
  store: TraceStore,
  id: number,
  callerId: string | undefined,
  tokens: number,
  cost?: number,
  endedAt = now,
  failure = false,
) {
  const traceId = id.toString(16).padStart(32, '0');
  const spanId = id.toString(16).padStart(16, '0');
  const attrs = {
    'aio_proxy.request.id': `request-${id}`,
    'gen_ai.request.model': 'model',
    ...(callerId === undefined
      ? {}
      : {
          'aio_proxy.caller.id': callerId,
          'aio_proxy.caller.label': callerId,
          'aio_proxy.caller.kind': callerId === 'anonymous' ? 'anonymous' : 'key',
        }),
  };
  const root = rootSpan({
    statusCode: failure ? 2 : 0,
    traceId,
    spanId,
    attributes: attrs,
    startedAt: new Date(endedAt.getTime() - 100),
    endedAt,
  });
  store.startRoot(rootStart({ traceId, spanId, attributes: attrs, startedAt: root.startedAt }));
  const input = completion({
    traceId,
    rootSpanId: spanId,
    spans: [
      root,
      attemptSpan({
        traceId,
        parentSpanId: spanId,
        endedAt,
        attributes: {
          'aio_proxy.attempt.index': 0,
          'aio_proxy.provider.id': 'provider',
          'aio_proxy.transport': 'ai_sdk',
          ...(failure ? { 'aio_proxy.termination.reason': 'failure' } : {}),
        },
      }),
    ],
    summary: {
      finalProviderId: 'provider',
      finalModelId: 'model',
      ...(failure
        ? { terminationReason: 'failure' as const }
        : {
            usage: {
              providerId: 'provider',
              modelId: 'model',
              inputTokens: tokens,
              outputTokens: 0,
              totalTokens: tokens,
              ...(cost === undefined ? {} : { estimatedCostUsd: cost }),
            },
          }),
    },
  });
  expect(store.complete(input)).toBe(true);
  expect(store.complete(input)).toBe(false);
}

test('each caller filters KPI, previous period, trends, Provider health, model ranking, activity and traces consistently', () => {
  const handle = openTestDb();
  try {
    const store = createTraceStore(handle.db);
    seed(store, 1, 'alice', 100, 2);
    seed(store, 2, 'bob', 500, 1);
    seed(store, 3, 'alice', 0, undefined, now, true);
    seed(store, 4, 'anonymous', 25);
    seed(store, 5, undefined, 50, 0.5);
    seed(store, 6, 'alice', 40, 0.2, new Date(now.getTime() - 25 * 3_600_000));
    const query = { range: '24h' as const, now, callerId: 'alice' };
    const overview = store.overviewDashboard(query);
    expect(overview.summary.current).toMatchObject({
      requestCount: '2',
      totalTokens: '100',
      estimatedCostNanoUsd: '2000000000',
    });
    expect(overview.summary.previous).toMatchObject({ requestCount: '1', totalTokens: '40' });
    expect(
      overview.modelTrendByMetric.tokens.buckets.reduce(
        (sum, bucket) => sum + Object.values(bucket.values).reduce((v, n) => v + BigInt(n), 0n),
        0n,
      ),
    ).toBe(100n);
    const diagnostics = store.overviewDashboardDiagnostics(query);
    expect(diagnostics.topModelTokens).toEqual([{ modelId: 'model', totalTokens: '100' }]);
    expect(diagnostics.topModelCosts).toEqual([{ modelId: 'model', estimatedCostNanoUsd: '2000000000' }]);
    expect(diagnostics.providerHealth).toMatchObject([
      { providerId: 'provider', totalTokens: '100', successRate: 0.5 },
    ]);
    expect(
      store
        .overviewDashboardActivity({ now, callerId: 'alice' })
        .items.reduce((sum, day) => sum + BigInt(day.totalTokens), 0n),
    ).toBe(140n);
    const ranking = store.callerRanking({ range: '24h', now });
    expect(ranking.find((row) => row.id === 'alice')).toMatchObject({
      requestCount: '2',
      totalTokens: '100',
      estimatedCostNanoUsd: '2000000000',
    });
    expect(ranking.find((row) => row.id === 'anonymous')?.totalTokens).toBe('25');
    expect(ranking.find((row) => row.id === 'legacy')?.totalTokens).toBe('50');
    const traces = store.list({ pageSize: 50, callerId: 'alice' });
    expect(traces.items).toHaveLength(3);
    expect(traces.items.every((item) => item.caller?.id === 'alice')).toBe(true);
    expect(store.list({ pageSize: 50, callerId: 'legacy' }).items).toHaveLength(1);
    expect(
      store.summary({ callerId: 'alice', startedAfter: new Date(now.getTime() - 24 * 3_600_000), startedBefore: now })
        .totals,
    ).toEqual({ success: 1, error: 1 });
  } finally {
    handle.close();
  }
});

test('per-caller daily totals survive trace pruning, preserve bigint precision and agree with all-user totals', () => {
  const handle = openTestDb();
  try {
    const store = createTraceStore(handle.db);
    const old = new Date(now.getTime() - 60 * 86_400_000);
    seed(store, 1, 'alice', Number.MAX_SAFE_INTEGER, 2, old);
    seed(store, 2, 'alice', 10, undefined, old);
    seed(store, 3, 'bob', 40, 1, old);
    store.prune(new Date(now.getTime() - 45 * 86_400_000), now);
    expect(store.list({ pageSize: 50 }).items).toHaveLength(0);
    const alice = store.overviewDashboard({ range: '90d', now, callerId: 'alice' });
    expect(alice.summary.current).toMatchObject({
      requestCount: '2',
      totalTokens: '9007199254741001',
      estimatedCostNanoUsd: '2000000000',
    });
    expect(store.overviewDashboardDiagnostics({ range: '90d', now, callerId: 'bob' }).topModelTokens).toEqual([
      { modelId: 'model', totalTokens: '40' },
    ]);
    const ranking = store.callerRanking({ range: '90d', now });
    expect(ranking.find((row) => row.id === 'alice')?.totalTokens).toBe('9007199254741001');
    expect(ranking.reduce((sum, row) => sum + BigInt(row.totalTokens), 0n).toString()).toBe(
      store.overviewDashboard({ range: '90d', now }).summary.current.totalTokens,
    );
  } finally {
    handle.close();
  }
});

test('legacy credentials retain random identity across restart, rename and credential rotation without exposing secrets', () => {
  const home = tempHome();
  let handle = openDb({ home });
  let store = createTraceStore(handle.db);
  const alice = store.resolveUsageCaller({ key: 'short-secret', label: 'Alice' });
  expect(alice.id).toMatch(/^[0-9a-f-]{36}$/u);
  handle.close();
  handle = openDb({ home });
  try {
    store = createTraceStore(handle.db);
    expect(store.resolveUsageCaller({ key: 'short-secret', label: 'Renamed' })).toEqual({ ...alice, label: 'Renamed' });
    seed(store, 1, alice.id, 100, 2);
    const rotated = store.resolveUsageCaller({ key: 'rotated-secret', id: alice.id, label: 'Renamed' });
    expect(rotated.id).toBe(alice.id);
    expect(store.resolveUsageCaller({ key: 'rotated-secret', label: 'Renamed' }).id).toBe(alice.id);
    const wire = JSON.stringify({
      callers: store.usageCallers(),
      ranking: store.callerRanking({ range: '24h', now }),
      traces: store.list({ pageSize: 50 }),
    });
    expect(wire).not.toContain('short-secret');
    expect(wire).not.toContain('rotated-secret');
    expect(wire).not.toContain('fingerprint');
    expect(store.callerRanking({ range: '24h', now })[0]?.label).toBe('Renamed');
    expect(store.find('1'.padStart(32, '0'))?.trace.caller?.id).toBe(alice.id);
  } finally {
    handle.close();
  }
});

test('recovered in-flight requests retain their caller and are rolled up once', () => {
  const handle = openTestDb();
  try {
    const store = createTraceStore(handle.db);
    store.startRoot(rootStart({ attributes: { 'aio_proxy.caller.id': 'alice' } }));
    expect(store.recover(now)).toBe(1);
    expect(store.recover(now)).toBe(0);
    expect(store.overviewDashboard({ range: '7d', now, callerId: 'alice' }).summary.current.requestCount).toBe('1');
    expect(store.callerRanking({ range: '7d', now })).toMatchObject([
      { id: 'alice', requestCount: '1', totalTokens: '0' },
    ]);
  } finally {
    handle.close();
  }
});
