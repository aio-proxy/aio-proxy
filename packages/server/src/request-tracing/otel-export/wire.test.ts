import { expect, test } from 'bun:test';

import { getTraceRuntime, stopOtelExport, syncOtelDestinations } from '..';
import type { ServerLog } from '../../server-log';

test('buffers an ended span with no destination and logs a destination the exporter rejects', () => {
  const logs: ServerLog[] = [];
  const logger = (entry: ServerLog): void => {
    logs.push(entry);
  };

  syncOtelDestinations([], logger);
  const { exporter, processor, tracer } = getTraceRuntime();
  const span = tracer.startSpan('wired');
  const traceId = span.spanContext().traceId;
  processor.register(traceId);
  expect(() => span.end()).not.toThrow();
  expect(processor.take(traceId).map((record) => record.name)).toEqual(['wired']);
  expect(typeof exporter.sync).toBe('function');
  expect(typeof exporter.stop).toBe('function');

  expect(stopOtelExport()).toBeUndefined();

  expect(() => syncOtelDestinations([{ url: 'not-a-url', contentType: 'json', headers: {} }], logger)).not.toThrow();
  expect(logs).toEqual([
    {
      event: 'otel.export',
      category: 'destination_unavailable',
      index: 0,
      origin: 'unknown',
    },
  ]);
});
