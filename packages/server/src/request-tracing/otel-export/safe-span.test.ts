import { expect, test } from 'bun:test';

import { SpanStatusCode } from '@opentelemetry/api';
import { AlwaysOnSampler, NodeTracerProvider, type ReadableSpan } from '@opentelemetry/sdk-trace-node';

import { toExportableSpan } from './safe-span';

test('exports an allowlisted view and leaves the original span unchanged', () => {
  const readableSpans: ReadableSpan[] = [];
  const provider = new NodeTracerProvider({
    sampler: new AlwaysOnSampler(),
    spanProcessors: [
      {
        onStart() {},
        onEnd(span) {
          readableSpans.push(span);
        },
        forceFlush: () => Promise.resolve(),
        shutdown: () => Promise.resolve(),
      },
    ],
  });
  const span = provider.getTracer('test').startSpan('aio_proxy.request');
  span.setAttribute('gen_ai.request.model', 'ok-model');
  span.setAttribute('secret.prompt', 'sentinel-prompt');
  span.recordException(new Error('sentinel-stack'));
  span.setStatus({ code: SpanStatusCode.ERROR, message: 'sentinel-status' });
  span.end();

  const readable = readableSpans[0];
  expect(readable).toBeDefined();
  if (readable === undefined) return;

  const exported = toExportableSpan(readable);
  const originalException = readable.events.find((event) => event.name === 'exception');
  const exportedException = exported.events.find((event) => event.name === 'exception');

  expect(exported.attributes['gen_ai.request.model']).toBe('ok-model');
  expect(exported.attributes['secret.prompt']).toBeUndefined();
  expect(originalException?.attributes?.['exception.stacktrace']).toEqual(expect.any(String));
  expect(exportedException?.name).toBe('exception');
  expect(exportedException?.time).toBe(originalException?.time);
  expect(exportedException?.attributes?.['exception.stacktrace']).toBeUndefined();
  expect(exported.status.code).toBe(SpanStatusCode.ERROR);
  expect(exported.status.message).toBeUndefined();
  expect(readable.attributes['secret.prompt']).toBe('sentinel-prompt');
  expect(readable.status.message).toBe('sentinel-status');
  expect(exported.startTime).toBe(readable.startTime);
  expect(exported.endTime).toBe(readable.endTime);
});
