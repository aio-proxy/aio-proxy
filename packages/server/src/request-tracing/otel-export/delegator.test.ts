import { describe, expect, test } from 'bun:test';

import { ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api';
import {
  AlwaysOnSampler,
  NodeTracerProvider,
  type ReadableSpan,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';

import type { ServerLog } from '../../server-log';
import { createOtelExportDelegator, type OtelDestination, type OtelExportDelegator } from './delegator';

type RecordedProcessor = {
  readonly processor: SpanProcessor;
  readonly received: ReadableSpan[];
  shutdowns: number;
  flushes: number;
};

function destination(
  url: string,
  headers: Record<string, string> = {},
  contentType: OtelDestination['contentType'] = 'json',
): OtelDestination {
  return { url, contentType, headers };
}

function recordedProcessor(shutdown: () => Promise<void> = () => Promise.resolve()): RecordedProcessor {
  const received: ReadableSpan[] = [];
  const recorded: RecordedProcessor = {
    received,
    shutdowns: 0,
    flushes: 0,
    processor: {
      onStart() {},
      onEnd(span) {
        received.push(span);
      },
      forceFlush: async () => {
        recorded.flushes += 1;
      },
      shutdown: () => {
        recorded.shutdowns += 1;
        return shutdown();
      },
    },
  };
  return recorded;
}

function harness(
  createProcessor: (destination: OtelDestination, index: number) => SpanProcessor,
  timeoutMs?: number,
): {
  readonly logs: ServerLog[];
  readonly delegator: OtelExportDelegator;
  readonly tracer: ReturnType<NodeTracerProvider['getTracer']>;
  readonly other: ReturnType<NodeTracerProvider['getTracer']>;
} {
  const logs: ServerLog[] = [];
  const delegator = createOtelExportDelegator({
    logger: (entry) => logs.push(entry),
    createProcessor,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const provider = new NodeTracerProvider({
    sampler: new AlwaysOnSampler(),
    spanProcessors: [delegator],
  });
  return {
    logs,
    delegator,
    tracer: provider.getTracer('@aio-proxy/server'),
    other: provider.getTracer('other'),
  };
}

function names(recorded: RecordedProcessor | undefined): string[] {
  return recorded?.received.map((span) => span.name) ?? [];
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function rejectWith(fields: Record<string, unknown> = {}): Promise<void> {
  return Promise.reject(Object.assign(new Error('secret-body'), fields));
}

describe('createOtelExportDelegator', () => {
  test('keeps identical destinations as separate processors and retires only the removed one', () => {
    const created: RecordedProcessor[] = [];
    const { delegator, tracer } = harness(() => {
      const recorded = recordedProcessor();
      created.push(recorded);
      return recorded.processor;
    });
    const dest = destination('https://a.example/v1/traces', { Authorization: 'secret' });

    delegator.sync([dest, dest]);
    tracer.startSpan('one').end();

    expect(created).toHaveLength(2);
    expect(names(created[0])).toEqual(['one']);
    expect(names(created[1])).toEqual(['one']);

    delegator.sync([dest]);
    tracer.startSpan('two').end();

    expect(created).toHaveLength(2);
    expect(created[0]?.shutdowns).toBe(0);
    expect(created[1]?.shutdowns).toBe(1);
    expect(names(created[0])).toEqual(['one', 'two']);
    expect(names(created[1])).toEqual(['one']);
  });

  test('does not recreate a processor when header key order changes', () => {
    let calls = 0;
    const { delegator } = harness(() => {
      calls += 1;
      return recordedProcessor().processor;
    });

    delegator.sync([destination('https://a.example/v1/traces', { Beta: '2', Alpha: '1' })]);
    delegator.sync([destination('https://a.example/v1/traces', { Alpha: '1', Beta: '2' })]);

    expect(calls).toBe(1);
  });

  test('delivers a child only to the destination active when it ends', () => {
    const created: RecordedProcessor[] = [];
    const { delegator, tracer } = harness(() => {
      const recorded = recordedProcessor();
      created.push(recorded);
      return recorded.processor;
    });

    delegator.sync([destination('https://a.example/v1/traces')]);
    const root = tracer.startSpan('root', { kind: SpanKind.SERVER }, ROOT_CONTEXT);
    const child = tracer.startSpan('child', {}, trace.setSpan(ROOT_CONTEXT, root));
    child.end();
    delegator.sync([destination('https://b.example/v1/traces')]);
    root.end();

    expect(names(created[0])).toEqual(['child']);
    expect(names(created[1])).toEqual(['root']);
  });

  test('logs destination_unavailable and leaves the retired processor unrestored', () => {
    const created: RecordedProcessor[] = [];
    let failIndex1 = false;
    const { delegator, tracer, logs } = harness((_destination, index) => {
      if (failIndex1 && index === 1) throw new Error('secret-body');
      const recorded = recordedProcessor();
      created.push(recorded);
      return recorded.processor;
    });

    delegator.sync([destination('https://a.example/v1/traces'), destination('https://old.example/v1/traces')]);
    failIndex1 = true;
    delegator.sync([
      destination('https://a.example/v1/traces'),
      destination('https://b.example/secret-body/v1/traces'),
    ]);
    tracer.startSpan('next').end();

    expect(logs).toEqual([
      {
        event: 'otel.export',
        category: 'destination_unavailable',
        index: 1,
        origin: 'https://b.example',
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain('secret-body');
    expect(created).toHaveLength(2);
    expect(created[0]?.shutdowns).toBe(0);
    expect(created[1]?.shutdowns).toBe(1);
    expect(names(created[0])).toEqual(['next']);
    expect(names(created[1])).toEqual([]);
  });

  test('does not log or surface a shutdown rejection without an HTTP status', async () => {
    const rejections: unknown[] = [];
    const onRejection = (error: unknown): void => {
      rejections.push(error);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const { delegator, logs } = harness(
        () => recordedProcessor(() => Promise.reject(new Error('secret-body'))).processor,
      );
      delegator.sync([destination('https://a.example/v1/traces')]);
      delegator.sync([]);
      await flushMicrotasks();

      expect(rejections).toEqual([]);
      expect(logs).toEqual([]);
      expect(JSON.stringify(logs)).not.toContain('secret-body');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  test('logs export_failed with only otel.export fields for an integer status from 100 to 599', async () => {
    const cases: ReadonlyArray<{
      readonly url: string;
      readonly shutdown: () => Promise<void>;
      readonly statusCode?: number;
    }> = [
      { url: 'https://code.example/v1/traces', shutdown: () => rejectWith({ code: 503 }), statusCode: 503 },
      {
        url: 'https://data.example/v1/traces',
        shutdown: () => rejectWith({ data: { code: 404 } }),
        statusCode: 404,
      },
      {
        url: 'https://prefer-code.example/v1/traces',
        shutdown: () => rejectWith({ code: 201, data: { code: 404 } }),
        statusCode: 201,
      },
      {
        url: 'https://fallback.example/v1/traces',
        shutdown: () => rejectWith({ code: 99, data: { code: 429 } }),
        statusCode: 429,
      },
      { url: 'https://low.example/v1/traces', shutdown: () => rejectWith({ code: 99 }) },
      { url: 'https://high.example/v1/traces', shutdown: () => rejectWith({ code: 600 }) },
      { url: 'https://fraction.example/v1/traces', shutdown: () => rejectWith({ code: 200.5 }) },
      { url: 'https://text.example/v1/traces', shutdown: () => rejectWith({ code: '503' }) },
      { url: 'https://message.example/v1/traces', shutdown: () => Promise.reject(new Error('500')) },
      { url: 'https://floor.example/v1/traces', shutdown: () => rejectWith({ code: 100 }), statusCode: 100 },
      { url: 'https://ceil.example/v1/traces', shutdown: () => rejectWith({ code: 599 }), statusCode: 599 },
    ];
    const pending = [...cases];
    const { delegator, logs } = harness(() => {
      const next = pending.shift();
      return recordedProcessor(next?.shutdown ?? (() => Promise.resolve())).processor;
    });

    for (const item of cases) delegator.sync([destination(item.url)]);
    delegator.sync([]);
    await flushMicrotasks();

    expect(logs).toEqual(
      cases.flatMap((item) =>
        item.statusCode === undefined
          ? []
          : [
              {
                event: 'otel.export',
                category: 'export_failed',
                index: 0,
                origin: new URL(item.url).origin,
                statusCode: item.statusCode,
              },
            ],
      ),
    );
    expect(JSON.stringify(logs)).not.toContain('secret-body');
    expect(JSON.stringify(logs)).not.toContain('500');
  });

  test('stop returns on the same turn while shutdown is still pending', () => {
    let received: ReadableSpan[] = [];
    const { delegator, tracer } = harness(() => {
      const recorded = recordedProcessor(() => new Promise(() => {}));
      received = recorded.received;
      return recorded.processor;
    });
    delegator.sync([destination('https://a.example/v1/traces')]);

    const result = delegator.stop();

    expect(result).toBeUndefined();
    tracer.startSpan('after-stop').end();
    expect(received).toEqual([]);
  });

  test('drops spans whose instrumentation scope is not @aio-proxy/server', () => {
    const created: RecordedProcessor[] = [];
    const { delegator, tracer, other } = harness(() => {
      const recorded = recordedProcessor();
      created.push(recorded);
      return recorded.processor;
    });
    delegator.sync([destination('https://a.example/v1/traces')]);

    other.startSpan('foreign').end();
    tracer.startSpan('local').end();

    expect(names(created[0])).toEqual(['local']);
  });

  test('keeps at most eight draining shutdowns and catches every rejection', async () => {
    const pending: Array<(error: unknown) => void> = [];
    const rejections: unknown[] = [];
    const onRejection = (error: unknown): void => {
      rejections.push(error);
    };
    process.on('unhandledRejection', onRejection);
    try {
      const { delegator } = harness(
        () =>
          recordedProcessor(
            () =>
              new Promise((_resolve, reject) => {
                pending.push(reject);
              }),
          ).processor,
      );

      for (let index = 0; index < 10; index += 1) {
        delegator.sync([destination(`https://slot-${index}.example/v1/traces`)]);
      }

      expect(delegator.drainingSize()).toBe(8);
      expect(pending).toHaveLength(9);
      for (const reject of pending) reject(new Error('secret-body'));
      await flushMicrotasks();

      expect(rejections).toEqual([]);
      expect(delegator.drainingSize()).toBe(0);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  test('forceFlush awaits only the processors still active', async () => {
    const created: RecordedProcessor[] = [];
    const { delegator } = harness(() => {
      const recorded = recordedProcessor();
      created.push(recorded);
      return recorded.processor;
    });

    delegator.sync([destination('https://a.example/v1/traces'), destination('https://b.example/v1/traces')]);
    await delegator.forceFlush();
    delegator.sync([destination('https://a.example/v1/traces')]);
    await delegator.forceFlush();

    expect(created.map((item) => item.flushes)).toEqual([2, 1]);
  });

  test('shutdown resolves without waiting for a hanging drain', async () => {
    let received: ReadableSpan[] = [];
    const { delegator, tracer } = harness(() => {
      const recorded = recordedProcessor(() => new Promise(() => {}));
      received = recorded.received;
      return recorded.processor;
    });
    delegator.sync([destination('https://a.example/v1/traces')]);

    await delegator.shutdown();
    tracer.startSpan('after-shutdown').end();

    expect(received).toEqual([]);
    expect(delegator.drainingSize()).toBe(1);
  });

  test('continues delivery when one processor throws from onEnd', () => {
    const received: ReadableSpan[] = [];
    let calls = 0;
    const { delegator, tracer } = harness(() => {
      calls += 1;
      if (calls === 1) {
        return {
          onStart() {},
          onEnd() {
            throw new Error('secret-body');
          },
          forceFlush: async () => {},
          shutdown: async () => {},
        };
      }
      return {
        onStart() {},
        onEnd(span) {
          received.push(span);
        },
        forceFlush: async () => {},
        shutdown: async () => {},
      };
    });

    delegator.sync([destination('https://a.example/v1/traces'), destination('https://b.example/v1/traces')]);
    const span = tracer.startSpan('kept');
    span.setAttribute('gen_ai.request.model', 'ok-model');
    span.setAttribute('secret.prompt', 'sentinel-prompt');
    span.end();

    expect(received.map((item) => item.name)).toEqual(['kept']);
    expect(received[0]?.attributes['gen_ai.request.model']).toBe('ok-model');
    expect(received[0]?.attributes['secret.prompt']).toBeUndefined();
  });

  test('removes a hanging shutdown from the draining list after timeoutMs', async () => {
    const { delegator } = harness(() => recordedProcessor(() => new Promise(() => {})).processor, 20);
    delegator.sync([destination('https://a.example/v1/traces')]);
    delegator.sync([]);

    expect(delegator.drainingSize()).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(delegator.drainingSize()).toBe(0);
  });
});
