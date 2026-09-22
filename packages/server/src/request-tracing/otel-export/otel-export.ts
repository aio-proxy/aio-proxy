import type { OtelDestination } from '@aio-proxy/types';

import { logServerEvent, type ServerLogSink } from '../../server-log';
import { getTraceRuntime } from '../runtime';
import { createOtelExportDelegator, type OtelExportDelegator } from './delegator';
import { createDestinationProcessor } from './exporters';

let processLogger: ServerLogSink = () => {};

export function createProcessOtelDelegator(): OtelExportDelegator {
  return createOtelExportDelegator({
    createProcessor: createDestinationProcessor,
    // bindOtelDiag stores this function on the first processor, so it must read the logger current at sync time.
    logger: (entry) => processLogger(entry),
  });
}

export function syncOtelDestinations(destinations: readonly OtelDestination[], logger: ServerLogSink): void {
  processLogger = logger;
  try {
    getTraceRuntime().exporter.sync(destinations);
  } catch {
    logServerEvent(logger, {
      event: 'otel.export',
      category: 'destination_unavailable',
      index: -1,
      origin: 'unknown',
    });
  }
}
