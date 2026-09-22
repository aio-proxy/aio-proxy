import type { Tracer } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { AlwaysOnSampler, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';

import { BufferingSpanProcessor } from './buffering-span-processor';
import { createProcessOtelDelegator, type OtelExportDelegator } from './otel-export';

export type TraceRuntime = {
  readonly processor: BufferingSpanProcessor;
  readonly exporter: OtelExportDelegator;
  readonly tracer: Tracer;
};

let runtime: TraceRuntime | undefined;

export function getTraceRuntime(): TraceRuntime {
  if (runtime !== undefined) return runtime;
  const processor = new BufferingSpanProcessor();
  const exporter = createProcessOtelDelegator();
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'aio-proxy' }),
    sampler: new AlwaysOnSampler(),
    spanProcessors: [processor, exporter],
  });
  provider.register();
  runtime = { processor, exporter, tracer: provider.getTracer('@aio-proxy/server', '0.0.0') };
  return runtime;
}

export function stopOtelExport(): void {
  runtime?.exporter.stop();
}
