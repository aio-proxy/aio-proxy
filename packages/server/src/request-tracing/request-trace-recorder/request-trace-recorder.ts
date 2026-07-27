import type { TraceStore } from '@aio-proxy/core/db';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  isSpanContextValid,
  propagation,
  trace,
  type Context,
  type Link,
} from '@opentelemetry/api';

import type { LogicalSessionResolution } from '../../logical-session-store';
import { logServerEvent, type ServerLogSink, serverErrorType } from '../../server-log';
import { getTraceRuntime } from '../runtime';
import { attributeName, spanName } from '../semantic';
import { applyTerminalAttributes, buildCompletion } from './completion';
import type { RequestTraceFinishInput, RequestTraceIdentityInput } from './types';

export type { RequestTraceFinishInput, RequestTraceIdentityInput } from './types';

const RETENTION_MS = 45 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export type RequestTraceWriteStore = Pick<TraceStore, 'startRoot' | 'complete' | 'prune' | 'recover'>;

export type RequestTraceSession = {
  readonly requestId: string;
  readonly traceId: string;
  readonly rootSpanId: string;
  readonly rootContext: Context;
  readonly identify: (input: RequestTraceIdentityInput) => void;
  readonly finish: (input: RequestTraceFinishInput) => boolean;
  readonly finishFrom: (completion: Promise<RequestTraceFinishInput>) => void;
};

export type RequestTraceRecorder = {
  readonly begin: (input: {
    readonly headers: Headers;
    readonly inboundProtocol: string;
    readonly operation?: 'model' | 'token_count';
  }) => RequestTraceSession;
};

type SessionState = 'pending' | 'async-owned' | 'finished';

type IdentityState = {
  requestedModelId: string | undefined;
  resolution: LogicalSessionResolution | undefined;
  mutateSessionState: boolean;
};

export function createRequestTraceRecorder(options: {
  readonly store: RequestTraceWriteStore;
  readonly now?: () => Date;
  readonly logger?: ServerLogSink;
  readonly onResponsePersisted?: (responseId: string) => void;
}): RequestTraceRecorder {
  const now = options.now ?? (() => new Date());
  let lastPrunedAt = now();
  runPrune(options.store, options.logger, lastPrunedAt);
  runRecover(options.store, options.logger, lastPrunedAt);

  return {
    begin(input) {
      const current = now();
      if (current.getTime() - lastPrunedAt.getTime() >= PRUNE_INTERVAL_MS) {
        lastPrunedAt = current;
        runPrune(options.store, options.logger, current);
      }

      const requestId = crypto.randomUUID();
      const { tracer, processor } = getTraceRuntime();
      const links = extractIncomingLinks(input.headers);

      const root = tracer.startSpan(
        spanName.request,
        {
          kind: SpanKind.SERVER,
          links,
          attributes: {
            [attributeName.requestId]: requestId,
            [attributeName.inboundProtocol]: input.inboundProtocol,
            [attributeName.operation]: input.operation ?? 'model',
          },
        },
        ROOT_CONTEXT,
      );
      const rootContext = trace.setSpan(ROOT_CONTEXT, root);
      const traceId = root.spanContext().traceId;
      const rootSpanId = root.spanContext().spanId;
      processor.register(traceId);

      const identity: IdentityState = {
        requestedModelId: input.operation === 'token_count' ? 'unknown' : undefined,
        resolution: undefined,
        mutateSessionState: false,
      };
      let state: SessionState = 'pending';

      persistSafely(
        () =>
          options.store.startRoot({
            traceId,
            spanId: rootSpanId,
            requestId,
            inboundProtocol: input.inboundProtocol,
            name: spanName.request,
            kind: SpanKind.SERVER,
            startedAt: current,
            statusCode: SpanStatusCode.UNSET,
            attributes: {
              [attributeName.requestId]: requestId,
              [attributeName.inboundProtocol]: input.inboundProtocol,
              [attributeName.operation]: input.operation ?? 'model',
            },
            events: [],
            links: links.map((link) => ({
              traceId: link.context.traceId,
              spanId: link.context.spanId,
              attributes: {},
            })),
          }),
        options.logger,
        { operation: 'root_start', requestId, traceId, spanId: rootSpanId },
      );

      const complete = (finish: RequestTraceFinishInput): void => {
        if (state === 'finished') return;
        state = 'finished';
        try {
          applyTerminalAttributes(root, finish, identity);
          root.end();
          const completion = buildCompletion({ traceId, rootSpanId, spans: processor.take(traceId), finish, identity });
          const persisted = persistSafely(() => options.store.complete(completion), options.logger, {
            operation: 'complete',
            requestId,
            traceId,
            spanId: rootSpanId,
          });
          const responseId = completion.sessionState?.responseId;
          if (persisted === true && responseId !== undefined && options.onResponsePersisted !== undefined) {
            persistSafely(() => options.onResponsePersisted?.(responseId), options.logger, {
              operation: 'response_reconcile',
              requestId,
              traceId,
              spanId: rootSpanId,
            });
          }
        } finally {
          processor.abandon(traceId);
        }
      };

      return {
        requestId,
        traceId,
        rootSpanId,
        rootContext,
        identify(input) {
          if (state !== 'pending') return;
          if (identity.resolution === undefined) {
            identity.requestedModelId = input.requestedModelId;
            identity.resolution = input.resolution;
            identity.mutateSessionState = input.mutateSessionState;
            return;
          }
          if (
            identity.requestedModelId === input.requestedModelId &&
            identity.resolution.identity.id === input.resolution.identity.id &&
            identity.resolution.identity.source === input.resolution.identity.source
          ) {
            return;
          }
          if (options.logger !== undefined) {
            logServerEvent(options.logger, {
              event: 'request.recorder_invariant',
              requestId,
              invariant: 'requested_model_conflict',
            });
          }
        },
        finish(finish) {
          if (state !== 'pending') return false;
          complete(finish);
          return true;
        },
        finishFrom(promise) {
          if (state !== 'pending') return;
          state = 'async-owned';
          void promise.then(
            (terminal) => {
              if (state !== 'async-owned') return;
              complete(terminal);
            },
            () => {
              if (state !== 'async-owned') return;
              complete({ outcome: 'failure' });
            },
          );
        },
      };
    },
  };
}

function extractIncomingLinks(headers: Headers): Link[] {
  const extracted = propagation.extract(ROOT_CONTEXT, headers, {
    get: (carrier, key) => carrier.get(key) ?? undefined,
    keys: (carrier) => [...carrier.keys()],
  });
  const incoming = trace.getSpanContext(extracted);
  return incoming !== undefined && isSpanContextValid(incoming) ? [{ context: incoming }] : [];
}

function runPrune(store: RequestTraceWriteStore, logger: ServerLogSink | undefined, now: Date): void {
  persistSafely(() => store.prune(new Date(now.getTime() - RETENTION_MS), now), logger, { operation: 'prune' });
}

// Roots left running by an unclean shutdown are marked interrupted at startup so
// they leave the running set and are counted in usage_daily.
function runRecover(store: RequestTraceWriteStore, logger: ServerLogSink | undefined, now: Date): void {
  persistSafely(() => store.recover(now), logger, { operation: 'recover' });
}

function persistSafely<T>(
  task: () => T,
  logger: ServerLogSink | undefined,
  failure: {
    readonly operation: 'root_start' | 'complete' | 'prune' | 'recover' | 'response_reconcile';
    readonly requestId?: string;
    readonly traceId?: string;
    readonly spanId?: string;
  },
): T | undefined {
  try {
    return task();
  } catch (error) {
    if (logger !== undefined) {
      logServerEvent(logger, {
        event: 'trace.persistence_failed',
        ...failure,
        errorType: serverErrorType(error),
      });
    }
    return undefined;
  }
}
