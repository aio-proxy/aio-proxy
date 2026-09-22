import type { OtelDestination } from '@aio-proxy/types';
import { diag, DiagLogLevel, type DiagLogger } from '@opentelemetry/api';
import { OTLPTraceExporter as JsonTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPTraceExporter as ProtoTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';

import { logServerEvent, type ServerLogSink } from '../../server-log';
import type { DestinationIdentity } from './delegator';
import { httpStatusCode } from './http-status';

// @opentelemetry/core ExportResultCode.FAILED. core is not a direct dependency.
const ExportResultCode = { FAILED: 1 } as const;
const PARTIAL_SUCCESS = 'Received Partial Success response:';

type ActiveDestination = {
  readonly index: number;
  readonly origin: string;
};

let readActive: () => readonly ActiveDestination[] = () => [];
let exportLogger: ServerLogSink = () => {};
let diagInstalled = false;

function installedDiagLogger(): DiagLogger | undefined {
  // The 1.x diag API keeps the active logger on this global. There is no public getter.
  const api = (globalThis as Record<symbol, { diag?: DiagLogger } | undefined>)[Symbol.for('opentelemetry.js.api.1')];
  return api?.diag;
}

function forward(logger: DiagLogger | undefined, method: keyof DiagLogger, args: readonly unknown[]): void {
  const fn = logger?.[method] as ((...values: unknown[]) => void) | undefined;
  fn?.(...args);
}

export function bindOtelDiag(getActive: () => readonly ActiveDestination[], logger: ServerLogSink): void {
  readActive = getActive;
  exportLogger = logger;
  if (diagInstalled) return;
  diagInstalled = true;
  const previous = installedDiagLogger();
  diag.setLogger(
    {
      error: (...args) => {
        forward(previous, 'error', args);
      },
      warn: (message, ...args) => {
        if (message === PARTIAL_SUCCESS) {
          for (const slot of readActive()) {
            logServerEvent(exportLogger, {
              event: 'otel.export',
              category: 'partial_success',
              index: slot.index,
              origin: slot.origin,
            });
          }
          return;
        }
        forward(previous, 'warn', [message, ...args]);
      },
      info: (...args) => {
        forward(previous, 'info', args);
      },
      debug: (...args) => {
        forward(previous, 'debug', args);
      },
      verbose: (...args) => {
        forward(previous, 'verbose', args);
      },
    },
    { logLevel: DiagLogLevel.ALL, suppressOverrideMessage: true },
  );
}

function reportingExporter(inner: SpanExporter, identity: DestinationIdentity, logger: ServerLogSink): SpanExporter {
  return {
    export(spans: ReadableSpan[], resultCallback) {
      inner.export(spans, (result) => {
        if (result.code === ExportResultCode.FAILED) {
          const statusCode = httpStatusCode(result.error);
          logServerEvent(logger, {
            event: 'otel.export',
            category: 'export_failed',
            index: identity.index,
            origin: identity.origin,
            ...(statusCode === undefined ? {} : { statusCode }),
          });
        }
        resultCallback(result);
      });
    },
    shutdown() {
      return inner.shutdown();
    },
    forceFlush() {
      return inner.forceFlush?.() ?? Promise.resolve();
    },
  };
}

export function createDestinationProcessor(destination: OtelDestination, identity: DestinationIdentity): SpanProcessor {
  const logger = exportLogger;
  // The SDK types compression as a string enum. CompressionAlgorithm.NONE is 'none'.
  type ExporterConfig = NonNullable<ConstructorParameters<typeof JsonTraceExporter>[0]>;
  const config: ExporterConfig = {
    url: destination.url,
    headers: destination.headers,
    compression: 'none' as ExporterConfig['compression'],
    timeoutMillis: 10_000,
  };
  const exporter =
    destination.contentType === 'protobuf' ? new ProtoTraceExporter(config) : new JsonTraceExporter(config);
  return new BatchSpanProcessor(reportingExporter(exporter, identity, logger));
}
