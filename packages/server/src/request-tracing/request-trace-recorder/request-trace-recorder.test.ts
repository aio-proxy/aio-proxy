import { describe, expect, test } from 'bun:test';

import type { StoredSpan, TraceCompletion, TraceRootStart } from '@aio-proxy/core/db';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';

import type { LogicalSessionResolution } from '../../logical-session-store';
import type { ServerLog } from '../../server-log';
import { getTraceRuntime } from '../runtime';
import { attributeName, spanName } from '../semantic';
import { createRequestTraceRecorder } from './request-trace-recorder';
import type { RequestTraceIdentityInput } from './types';

function collector() {
  const roots: TraceRootStart[] = [];
  const completions: TraceCompletion[] = [];
  const logs: ServerLog[] = [];
  const store = {
    startRoot: (input: TraceRootStart) => void roots.push(input),
    complete: (input: TraceCompletion) => {
      completions.push(input);
      return true;
    },
    prune: () => {},
    recover: () => {},
  };
  const logger = (entry: ServerLog) => void logs.push(entry);
  return { roots, completions, logs, store, logger };
}

const identityInput: RequestTraceIdentityInput = {
  requestedModelId: 'gpt-4o',
  mutateSessionState: false,
  resolution: {
    requestId: 'req',
    session: { source: 'body-session', key: 'sha256:abc' },
    context: { requestId: 'req', session: { source: 'body-session', key: 'sha256:abc' } },
    identity: { source: 'body-session', id: 'sess-1' },
    resolvedBy: 'body-session',
  } as unknown as LogicalSessionResolution,
};

describe('createRequestTraceRecorder', () => {
  test('startRoot is called synchronously before begin returns', () => {
    const { roots, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ headers: new Headers(), inboundProtocol: 'openai-chat' });

    expect(roots).toHaveLength(1);
    expect(roots[0]?.traceId).toBe(session.traceId);
    expect(roots[0]?.spanId).toBe(session.rootSpanId);
    expect(roots[0]?.statusCode).toBe(SpanStatusCode.UNSET);
  });

  test('valid inbound traceparent becomes one root Link with a distinct local traceId', () => {
    const { roots, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const incomingTraceId = '0af7651916cd43dd8448eb211c80319c';
    const headers = new Headers({ traceparent: `00-${incomingTraceId}-b7ad6b7169203331-01` });

    const session = recorder.begin({ headers, inboundProtocol: 'openai-chat' });

    expect(roots[0]?.links).toHaveLength(1);
    expect(roots[0]?.links[0]?.traceId).toBe(incomingTraceId);
    expect(session.traceId).not.toBe(incomingTraceId);
  });

  test('malformed traceparent yields no Link and still creates the root', () => {
    const { roots, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({
      headers: new Headers({ traceparent: 'not-a-valid-traceparent' }),
      inboundProtocol: 'openai-chat',
    });

    expect(roots).toHaveLength(1);
    expect(roots[0]?.links).toHaveLength(0);
    expect(session.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  test('root stays running until finishFrom settles, then persists success as UNSET', async () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ headers: new Headers(), inboundProtocol: 'openai-chat' });

    let resolve: (() => void) | undefined;
    session.finishFrom(
      new Promise((r) => {
        resolve = () =>
          r({
            outcome: 'success',
            usage: { providerId: 'provider-a', modelId: 'gpt', inputTokens: 3, outputTokens: 5 },
          });
      }),
    );

    expect(completions).toHaveLength(0);
    resolve?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(completions).toHaveLength(1);
    expect(completions[0]?.summary.terminationReason).toBeUndefined();
    const root = completions[0]?.spans.find((span) => span.spanId === session.rootSpanId);
    expect(root?.statusCode).toBe(SpanStatusCode.UNSET);
    expect(completions[0]?.summary.finalProviderId).toBe('provider-a');
  });

  test('failure sets ERROR status and failure termination reason', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ headers: new Headers(), inboundProtocol: 'openai-chat' });

    expect(session.finish({ outcome: 'failure', errorType: 'UpstreamError', errorCode: 'bad_gateway' })).toBe(true);

    expect(completions[0]?.summary.terminationReason).toBe('failure');
    expect(completions[0]?.summary.errorType).toBe('UpstreamError');
    const root = completions[0]?.spans.find((span) => span.spanId === session.rootSpanId);
    expect(root?.statusCode).toBe(SpanStatusCode.ERROR);
  });

  test('cancelled sets ERROR status and cancelled termination reason', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ headers: new Headers(), inboundProtocol: 'openai-chat' });

    session.finish({ outcome: 'cancelled' });

    expect(completions[0]?.summary.terminationReason).toBe('cancelled');
    const root = completions[0]?.spans.find((span) => span.spanId === session.rootSpanId);
    expect(root?.statusCode).toBe(SpanStatusCode.ERROR);
  });

  test('double finish is a no-op', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ headers: new Headers(), inboundProtocol: 'openai-chat' });

    expect(session.finish({ outcome: 'success' })).toBe(true);
    expect(session.finish({ outcome: 'failure' })).toBe(false);
    expect(completions).toHaveLength(1);
  });

  test('a startRoot exception logs trace.persistence_failed with ids and does not throw', () => {
    const { logs } = collector();
    const throwingStore = {
      startRoot: () => {
        throw new Error('db down');
      },
      complete: () => true,
      prune: () => {},
      recover: () => {},
    };
    const recorder = createRequestTraceRecorder({ store: throwingStore, logger: (e: ServerLog) => void logs.push(e) });

    const session = recorder.begin({ headers: new Headers(), inboundProtocol: 'openai-chat' });

    const failure = logs.find((entry) => entry.event === 'trace.persistence_failed');
    expect(failure).toBeDefined();
    expect(failure).toMatchObject({
      operation: 'root_start',
      traceId: session.traceId,
      spanId: session.rootSpanId,
    });
  });

  test('only controlled attributes reach the stored span snapshot', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ headers: new Headers(), inboundProtocol: 'openai-chat' });

    const child = getTraceRuntime().tracer.startSpan(
      spanName.attempt,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          [attributeName.providerId]: 'provider-a',
          'gen_ai.prompt': 'secret',
          'aio_proxy.body': 'raw body',
        },
      },
      session.rootContext,
    );
    child.end();
    session.finish({ outcome: 'success' });

    const stored = completions[0]?.spans.find((span: StoredSpan) => span.name === spanName.attempt);
    expect(stored?.attributes).toEqual({ [attributeName.providerId]: 'provider-a' });
  });

  test('identify projects session identity onto the completion', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ headers: new Headers(), inboundProtocol: 'openai-chat' });

    session.identify(identityInput);
    session.finish({ outcome: 'success' });

    expect(completions[0]?.session).toEqual({
      identity: identityInput.resolution.identity,
      requestedModelId: identityInput.requestedModelId,
      resolvedBy: identityInput.resolution.resolvedBy,
    });
  });
});
