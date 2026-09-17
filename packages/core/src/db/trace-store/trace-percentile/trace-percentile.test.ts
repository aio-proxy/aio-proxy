import { expect, test } from 'bun:test';

import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';
import { attemptSpan, completion, rootSpan, rootStart } from '../trace-store.test-support';
import type { TraceStore } from '../types';

const NOW = new Date('2026-07-11T08:00:00.000Z');

function traceIdOf(id: number): string {
  return id.toString(16).padStart(32, '0');
}

/** 一条已结束的成功根调用链，起点落在 now 之前 `agoMs` 毫秒。 */
function seedTrace(
  store: TraceStore,
  seed: { readonly id: number; readonly durationMs: number; readonly modelId?: string; readonly agoMs?: number },
): void {
  const traceId = traceIdOf(seed.id);
  const spanId = seed.id.toString(16).padStart(16, '0');
  const modelId = seed.modelId ?? 'model-a';
  const startedAt = new Date(NOW.getTime() - (seed.agoMs ?? 60_000));
  const endedAt = new Date(startedAt.getTime() + seed.durationMs);
  const attributes = {
    'aio_proxy.request.id': `request-${seed.id}`,
    'aio_proxy.protocol.inbound': 'openai-response',
    'gen_ai.request.model': modelId,
    'gen_ai.response.model': modelId,
    'aio_proxy.route.final_provider_id': 'provider-a',
  };
  store.startRoot(rootStart({ traceId, spanId, requestId: `request-${seed.id}`, startedAt, attributes }));
  store.complete(
    completion({
      traceId,
      rootSpanId: spanId,
      spans: [
        rootSpan({ traceId, spanId, startedAt, endedAt, attributes }),
        attemptSpan({ traceId, spanId: `${spanId.slice(1)}f`, parentSpanId: spanId, startedAt, endedAt }),
      ],
      summary: { finalProviderId: 'provider-a', finalModelId: modelId, finalHttpStatus: 200 },
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

test('withholds the comparison until the window holds enough same-model samples', () => {
  withStore((store) => {
    for (let id = 1; id <= 29; id += 1) seedTrace(store, { id, durationMs: id * 10 });

    expect(store.percentile(traceIdOf(1), NOW).comparison).toBeNull();

    seedTrace(store, { id: 30, durationMs: 300 });
    const comparison = store.percentile(traceIdOf(1), NOW).comparison;

    expect(comparison).toMatchObject({ modelId: 'model-a', sampleCount: 30, windowMinutes: 60, durationMs: 10 });
    expect(comparison?.minMs).toBe(10);
    expect(comparison?.maxMs).toBe(300);
  });
});

test('ranks the slowest trace in the window at the top of the distribution', () => {
  withStore((store) => {
    for (let id = 1; id <= 30; id += 1) seedTrace(store, { id, durationMs: id * 10 });

    const fastest = store.percentile(traceIdOf(1), NOW).comparison;
    const slowest = store.percentile(traceIdOf(30), NOW).comparison;

    expect(fastest?.percentile).toBe(0);
    expect(slowest?.percentile).toBe(97);
    expect(slowest?.p50Ms).toBe(160);
    expect(slowest?.p95Ms).toBe(290);
  });
});

test('compares only against the same model inside the trailing hour', () => {
  withStore((store) => {
    for (let id = 1; id <= 30; id += 1) seedTrace(store, { id, durationMs: 100 });
    // 另一个模型 30 条 + 同模型但一小时之前 30 条，都不该进样本。
    for (let id = 101; id <= 130; id += 1) seedTrace(store, { id, durationMs: 100, modelId: 'model-b' });
    for (let id = 201; id <= 230; id += 1) seedTrace(store, { id, durationMs: 100, agoMs: 7_200_000 });

    expect(store.percentile(traceIdOf(1), NOW).comparison?.sampleCount).toBe(30);
    expect(store.percentile(traceIdOf(101), NOW).comparison?.modelId).toBe('model-b');
    // 窗口外的目标自己也拿不到对比：它的模型在窗口里只剩 30 条，但它不在其中，这里要的是
    // 「窗口外的样本不参与」——同模型窗口内刚好 30 条，所以有结果，且计数不含那 30 条旧的。
    expect(store.percentile(traceIdOf(201), NOW).comparison?.sampleCount).toBe(30);
  });
});

test('withholds the comparison for a trace that never finished', () => {
  withStore((store) => {
    for (let id = 1; id <= 30; id += 1) seedTrace(store, { id, durationMs: 100 });
    const running = traceIdOf(999);
    store.startRoot(
      rootStart({
        traceId: running,
        spanId: 'f'.repeat(16),
        requestId: 'request-running',
        startedAt: new Date(NOW.getTime() - 1_000),
      }),
    );

    expect(store.percentile(running, NOW).comparison).toBeNull();
  });
});
