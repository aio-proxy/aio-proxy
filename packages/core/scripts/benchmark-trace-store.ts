import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createTraceStore, openDb, type TraceCompletion, type TraceRootStart } from '../src/db';

const WARMUP_REQUESTS = 1_000;
const MEASURED_REQUESTS = 10_000;
const CHILD_SPANS = 10;
const BASE_TIME_MS = Date.UTC(2026, 6, 24);

type RequestWrites = {
  readonly start: TraceRootStart;
  readonly completion: TraceCompletion;
};

function requestWrites(index: number): RequestWrites {
  const traceId = index.toString(16).padStart(32, '0');
  const rootSpanId = index.toString(16).padStart(16, '0');
  const requestId = `benchmark-${index}`;
  const startedAt = new Date(BASE_TIME_MS + index);
  const endedAt = new Date(startedAt.getTime() + 100);
  const rootAttributes = {
    'aio_proxy.protocol.inbound': 'openai-response',
    'aio_proxy.request.id': requestId,
    'gen_ai.request.model': 'gpt-5',
  };
  const start: TraceRootStart = {
    traceId,
    spanId: rootSpanId,
    requestId,
    inboundProtocol: 'openai-response',
    name: 'aio_proxy.request',
    kind: 1,
    startedAt,
    statusCode: 0,
    attributes: rootAttributes,
    events: [],
    links: [],
  };

  return {
    start,
    completion: {
      traceId,
      rootSpanId,
      spans: [
        { ...start, endedAt },
        ...Array.from({ length: CHILD_SPANS }, (_, childIndex) => ({
          traceId,
          spanId: `f${childIndex.toString(16).padStart(15, '0')}`,
          parentSpanId: rootSpanId,
          name: 'aio_proxy.provider.attempt',
          kind: 3,
          startedAt,
          endedAt,
          statusCode: 1,
          attributes: {
            'aio_proxy.attempt.index': childIndex,
            'aio_proxy.provider.id': 'benchmark-provider',
            'aio_proxy.provider.kind': 'api',
            'gen_ai.response.model': 'gpt-5',
          },
          events: [],
          links: [],
        })),
      ],
      summary: {
        finalProviderId: 'benchmark-provider',
        finalModelId: 'gpt-5',
        finalHttpStatus: 200,
        usage: {
          providerId: 'benchmark-provider',
          modelId: 'gpt-5',
          inputTokens: 100,
          outputTokens: 50,
          totalTokens: 150,
          estimatedCostUsd: 0.001,
        },
      },
    },
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  return sorted[Math.ceil(sorted.length * quantile) - 1]!;
}

function summary(durations: readonly number[]): string {
  const sorted = [...durations].sort((left, right) => left - right);
  return `p50=${percentile(sorted, 0.5).toFixed(3)}ms p95=${percentile(sorted, 0.95).toFixed(3)}ms p99=${percentile(sorted, 0.99).toFixed(3)}ms`;
}

const home = mkdtempSync(join(tmpdir(), 'aio-proxy-trace-store-benchmark-'));
try {
  const handle = openDb({ home });
  try {
    const store = createTraceStore(handle.db);
    for (let index = 0; index < WARMUP_REQUESTS; index += 1) {
      const input = requestWrites(index);
      store.startRoot(input.start);
      store.complete(input.completion);
    }

    const requests = Array.from({ length: MEASURED_REQUESTS }, (_, index) => requestWrites(WARMUP_REQUESTS + index));
    const rootStartDurations: number[] = [];
    const terminalDurations: number[] = [];
    const combinedStartedAt = performance.now();
    for (const input of requests) {
      const startedAt = performance.now();
      store.startRoot(input.start);
      rootStartDurations.push(performance.now() - startedAt);
    }
    for (const input of requests) {
      const startedAt = performance.now();
      store.complete(input.completion);
      terminalDurations.push(performance.now() - startedAt);
    }
    const combinedElapsedMs = performance.now() - combinedStartedAt;

    console.log(
      `TraceStore benchmark: ${WARMUP_REQUESTS} warmup, ${MEASURED_REQUESTS} measured, ${CHILD_SPANS} child spans`,
    );
    console.log(`root-start ${summary(rootStartDurations)}`);
    console.log(`terminal ${summary(terminalDurations)}`);
    console.log(`combined requests/s=${((MEASURED_REQUESTS * 1_000) / combinedElapsedMs).toFixed(1)}`);
  } finally {
    handle.close();
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
