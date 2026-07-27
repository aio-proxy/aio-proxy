import { describe, expect, test } from 'bun:test';

import { SpanKind, trace, ROOT_CONTEXT } from '@opentelemetry/api';
import { AlwaysOnSampler, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { attributeName } from '../semantic';
import { BufferingSpanProcessor } from './buffering-span-processor';

function createHarness() {
  const processor = new BufferingSpanProcessor();
  const provider = new NodeTracerProvider({
    sampler: new AlwaysOnSampler(),
    spanProcessors: [processor],
  });
  return { processor, tracer: provider.getTracer('test') };
}

describe('BufferingSpanProcessor', () => {
  test('buffers ended spans for registered traces in end order and drains once', () => {
    const { processor, tracer } = createHarness();
    const root = tracer.startSpan('aio_proxy.request', { kind: SpanKind.SERVER }, ROOT_CONTEXT);
    const traceId = root.spanContext().traceId;
    processor.register(traceId);

    const rootContext = trace.setSpan(ROOT_CONTEXT, root);
    const child = tracer.startSpan('child', {}, rootContext);
    child.end();
    root.end();

    expect(processor.take(traceId).map(({ name }) => name)).toEqual(['child', 'aio_proxy.request']);
    expect(processor.take(traceId)).toEqual([]);
  });

  test('ignores spans from unregistered traces', () => {
    const { processor, tracer } = createHarness();
    const span = tracer.startSpan('orphan');
    span.end();

    expect(processor.take(span.spanContext().traceId)).toEqual([]);
  });

  test('abandon discards a registered buffer', () => {
    const { processor, tracer } = createHarness();
    const root = tracer.startSpan('aio_proxy.request', { kind: SpanKind.SERVER }, ROOT_CONTEXT);
    const traceId = root.spanContext().traceId;
    processor.register(traceId);
    root.end();

    processor.abandon(traceId);
    expect(processor.take(traceId)).toEqual([]);
  });

  test('keeps only allowlisted attributes and drops content attributes', () => {
    const { processor, tracer } = createHarness();
    const root = tracer.startSpan(
      'aio_proxy.request',
      {
        kind: SpanKind.SERVER,
        attributes: {
          [attributeName.providerId]: 'provider-a',
          'gen_ai.prompt': 'secret prompt',
          'aio_proxy.unknown': 'nope',
        },
      },
      ROOT_CONTEXT,
    );
    const traceId = root.spanContext().traceId;
    processor.register(traceId);
    root.end();

    const [record] = processor.take(traceId);
    expect(record?.attributes).toEqual({ [attributeName.providerId]: 'provider-a' });
  });
});
