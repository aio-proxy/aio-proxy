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

    expect(store.percentile(traceIdOf(1)).comparison).toBeNull();

    seedTrace(store, { id: 30, durationMs: 300 });
    const comparison = store.percentile(traceIdOf(1)).comparison;

    expect(comparison).toMatchObject({ modelId: 'model-a', sampleCount: 30, durationMs: 10 });
    expect(comparison?.minMs).toBe(10);
    expect(comparison?.maxMs).toBe(300);
  });
});

test('ranks the slowest trace in the window at the top of the distribution', () => {
  withStore((store) => {
    for (let id = 1; id <= 30; id += 1) seedTrace(store, { id, durationMs: id * 10 });

    const fastest = store.percentile(traceIdOf(1)).comparison;
    const slowest = store.percentile(traceIdOf(30)).comparison;

    expect(fastest?.percentile).toBe(0);
    expect(slowest?.percentile).toBe(97);
    expect(slowest?.p50Ms).toBe(160);
    expect(slowest?.p95Ms).toBe(290);
  });
});

test('compares only against the same model', () => {
  withStore((store) => {
    for (let id = 1; id <= 30; id += 1) seedTrace(store, { id, durationMs: 100 });
    for (let id = 101; id <= 130; id += 1) seedTrace(store, { id, durationMs: 100, modelId: 'model-b' });

    expect(store.percentile(traceIdOf(1)).comparison?.sampleCount).toBe(30);
    expect(store.percentile(traceIdOf(101)).comparison?.modelId).toBe('model-b');
    // 30 条一模一样快时谁都不比谁快：`lower` 是严格小于，所以是 p0。改成 `<=` 会让每一条都
    // 变成 p100（「比所有人都慢」），这条断言就是拦那个改动的。
    expect(store.percentile(traceIdOf(1)).comparison?.percentile).toBe(0);
  });
});

test('ranks a trace against the traffic around it, not against the newest traffic', () => {
  withStore((store) => {
    // 一分钟前的一批：全都 100ms。
    for (let id = 1; id <= 30; id += 1) seedTrace(store, { id, durationMs: 100 });
    // 两小时前的一批：慢得多，1000..1290ms。两批相距 2 小时，互相不在对方的窗口里。
    for (let id = 201; id <= 230; id += 1) {
      seedTrace(store, { id, durationMs: 1_000 + (id - 201) * 10, agoMs: 7_200_000 });
    }

    const old = store.percentile(traceIdOf(201)).comparison;
    const recent = store.percentile(traceIdOf(1)).comparison;

    // 两小时前那条要和它当时那批比：窗口锚在自己身上，1000..1290 才是它的分布。
    // 锚在「现在」的话这里会读到 100/100 —— 一条 1000ms 的调用链被排在一批 100ms 之外，
    // 于是显示成「最慢」，正是这次要修掉的错觉。
    expect(old).toMatchObject({ sampleCount: 30, minMs: 1_000, maxMs: 1_290, percentile: 0 });
    expect(recent).toMatchObject({ sampleCount: 30, minMs: 100, maxMs: 100 });
  });
});

test('counts neighbours that came after the trace, not only before it', () => {
  withStore((store) => {
    // 目标在 5 小时前，它的邻居全都比它晚（半小时后），窗口必须往后也张开一小时才看得见。
    seedTrace(store, { id: 700, durationMs: 500, agoMs: 18_000_000 });
    for (let id = 701; id <= 729; id += 1) seedTrace(store, { id, durationMs: 1_000, agoMs: 16_200_000 });
    // 目标之后 2 小时的一批：超出 +1h 的边界，不该进样本，否则 maxMs 会变成 9000。
    for (let id = 731; id <= 735; id += 1) seedTrace(store, { id, durationMs: 9_000, agoMs: 10_800_000 });

    // 锚在「现在」时这条 5 小时前的调用链一个样本都凑不到，整块会消失。
    expect(store.percentile(traceIdOf(700)).comparison).toMatchObject({
      sampleCount: 30,
      minMs: 500,
      maxMs: 1_000,
      percentile: 0,
    });
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

    expect(store.percentile(running).comparison).toBeNull();
  });
});
