import type { Tracer } from '@opentelemetry/api';
import { AlwaysOnSampler, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import { BufferingSpanProcessor } from './buffering-span-processor';

export type TraceRuntime = {
  readonly processor: BufferingSpanProcessor;
  readonly tracer: Tracer;
};

let runtime: TraceRuntime | undefined;

export function getTraceRuntime(): TraceRuntime {
  if (runtime !== undefined) return runtime;
  const processor = new BufferingSpanProcessor();
  const provider = new NodeTracerProvider({
    sampler: new AlwaysOnSampler(),
    spanProcessors: [processor],
  });
  provider.register();
  runtime = {
    processor,
    tracer: provider.getTracer('@aio-proxy/server', '0.0.0'),
  };
  return runtime;
}
