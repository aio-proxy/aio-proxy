import { describe, expect, test } from 'bun:test';

import type { StoredSpan, TraceCompletion, TraceRootStart } from '@aio-proxy/core/db';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';

import type { LogicalSessionResolution } from '../../logical-session-store';
import type { ServerLog } from '../../server-log';
import { getTraceRuntime } from '../runtime';
import { attributeName, spanName } from '../semantic';
import { createRequestTraceRecorder } from './request-trace-recorder';
import type { RequestTraceFinishInput, RequestTraceIdentityInput } from './types';

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

function request(headers?: HeadersInit): Request {
  return new Request('http://localhost', { headers });
}

describe('createRequestTraceRecorder', () => {
  test('startRoot is called synchronously before begin returns', () => {
    const { roots, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

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

    const session = recorder.begin({ inboundRequest: request(headers), inboundProtocol: 'openai-chat' });

    expect(roots[0]?.links).toHaveLength(1);
    expect(roots[0]?.links[0]?.traceId).toBe(incomingTraceId);
    expect(session.traceId).not.toBe(incomingTraceId);
  });

  test('malformed traceparent yields no Link and still creates the root', () => {
    const { roots, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({
      inboundRequest: request({ traceparent: 'not-a-valid-traceparent' }),
      inboundProtocol: 'openai-chat',
    });

    expect(roots).toHaveLength(1);
    expect(roots[0]?.links).toHaveLength(0);
    expect(session.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  test('root stays running until finishFrom settles, then persists success as UNSET', async () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

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

  test('finishFrom rejection persists stable failure metadata', async () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

    session.finishFrom(Promise.reject(new Error('stream failed')));
    await Promise.resolve();
    await Promise.resolve();

    expect(completions[0]?.summary).toMatchObject({ terminationReason: 'failure', errorCode: 'internal_error' });
  });

  test('failure sets ERROR status and failure termination reason', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

    expect(session.finish({ outcome: 'failure', errorType: 'UpstreamError', errorCode: 'bad_gateway' })).toBe(true);

    expect(completions[0]?.summary.terminationReason).toBe('failure');
    expect(completions[0]?.summary.errorType).toBe('UpstreamError');
    const root = completions[0]?.spans.find((span) => span.spanId === session.rootSpanId);
    expect(root?.statusCode).toBe(SpanStatusCode.ERROR);
  });

  test('4xx failure keeps the root span status UNSET but still records failure metadata', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

    session.finish({ outcome: 'failure', finalHttpStatus: 404, errorCode: 'model_not_found' });

    const root = completions[0]?.spans.find((span) => span.spanId === session.rootSpanId);
    expect(root?.statusCode).toBe(SpanStatusCode.UNSET);
    expect(root?.attributes['aio_proxy.termination.reason']).toBe('failure');
    expect(root?.attributes['aio_proxy.error.code']).toBe('model_not_found');
    expect(completions[0]?.summary.terminationReason).toBe('failure');
  });

  test('5xx failure still sets the root span status to ERROR', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

    session.finish({ outcome: 'failure', finalHttpStatus: 502, errorCode: 'internal_error' });

    const root = completions[0]?.spans.find((span) => span.spanId === session.rootSpanId);
    expect(root?.statusCode).toBe(SpanStatusCode.ERROR);
  });

  test('failure without an http status sets the root span status to ERROR', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

    session.finish({ outcome: 'failure', errorCode: 'internal_error' });

    const root = completions[0]?.spans.find((span) => span.spanId === session.rootSpanId);
    expect(root?.statusCode).toBe(SpanStatusCode.ERROR);
  });

  // 调用方主动取消不是错误（http-spans.md）。仪表盘靠 terminationReason 区分取消，
  // 不靠 span status —— 两条断言一起，防止有人把渲染改回读 status 时静默回归。
  test('cancelled leaves span status UNSET but still records the termination reason', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

    session.finish({ outcome: 'cancelled' });

    expect(completions[0]?.summary.terminationReason).toBe('cancelled');
    const root = completions[0]?.spans.find((span) => span.spanId === session.rootSpanId);
    expect(root?.statusCode).toBe(SpanStatusCode.UNSET);
    expect(root?.attributes['error.type']).toBeUndefined();
  });

  test('double finish is a no-op', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

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

    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

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
    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

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

  test('records standard HTTP root attributes without diagnostics or inferred body sizes', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const inboundRequest = new Request('http://localhost/v1/responses', {
      method: 'POST',
      headers: {
        authorization: 'Bearer authorization-secret',
        'api-key': 'api-key-secret',
        'x-api-key': 'x-api-key-secret',
        'x-goog-api-key': 'google-api-key-secret',
        cookie: 'session=cookie-secret',
        'content-type': 'application/json',
        'content-length': '35',
        'user-agent': 'diagnostics-test/1.0',
      },
      body: JSON.stringify({ input: 'prompt-secret-content' }),
    });
    const session = recorder.begin({
      inboundRequest,
      inboundProtocol: 'openai-response',
      httpRoute: '/v1/responses',
    });
    const clientResponse = new Response('generated-secret-content', {
      status: 201,
      headers: {
        'content-type': 'application/json',
        'content-length': '24',
        'set-cookie': 'response=set-cookie-secret',
        'x-api-key': 'response-api-key-secret',
      },
    });

    session.finish({ outcome: 'success', clientResponse });

    const root = completions[0]?.spans.find((span) => span.spanId === session.rootSpanId);
    expect(root?.name).toBe('POST /v1/responses');
    expect(root?.attributes).toMatchObject({
      'http.request.method': 'POST',
      'http.route': '/v1/responses',
      'url.path': '/v1/responses',
      'user_agent.original': 'diagnostics-test/1.0',
      'http.request.header.content-type': ['application/json'],
      'http.request.header.content-length': ['35'],
      'http.response.status_code': 201,
      'http.response.header.content-type': ['application/json'],
      'http.response.header.content-length': ['24'],
    });
    expect(root?.attributes['aio_proxy.operation']).toBeUndefined();
    expect(Object.keys(root?.attributes ?? {}).filter((key) => key.startsWith('aio_proxy.diagnostics.'))).toEqual([]);
    expect(Object.keys(root?.attributes ?? {}).filter((key) => key.includes('body.size'))).toEqual([]);
    expect(Object.keys(root?.attributes ?? {}).filter((key) => key.startsWith('gen_ai.'))).toEqual([]);
    const persisted = JSON.stringify(completions[0]);
    for (const rejected of [
      'authorization-secret',
      'api-key-secret',
      'x-api-key-secret',
      'google-api-key-secret',
      'cookie-secret',
      'set-cookie-secret',
      'response-api-key-secret',
      'prompt-secret-content',
      'generated-secret-content',
    ]) {
      expect(persisted).not.toContain(rejected);
    }
  });

  test('identify projects session identity onto the completion', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

    session.identify(identityInput);
    session.finish({ outcome: 'success' });

    expect(completions[0]?.session).toEqual({
      identity: identityInput.resolution.identity,
      requestedModelId: identityInput.requestedModelId,
      resolvedBy: identityInput.resolution.resolvedBy,
    });
  });

  test('projects stream intent but not logical TTFT onto the root span', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

    session.identify({ ...identityInput, streamRequested: true } as RequestTraceIdentityInput);
    session.finish({ outcome: 'success', ttftMs: 42 } as RequestTraceFinishInput);

    const root = completions[0]?.spans.find((span) => span.spanId === session.rootSpanId);
    expect(root?.attributes[attributeName.stream]).toBe(true);
    expect(root?.attributes[attributeName.ttftMs]).toBeUndefined();
  });

  test('projects fast-mode intent onto the root span', () => {
    const { completions, store } = collector();
    const recorder = createRequestTraceRecorder({ store });
    const session = recorder.begin({ inboundRequest: request(), inboundProtocol: 'openai-chat' });

    session.identify({ ...identityInput, fastRequested: true });
    session.finish({ outcome: 'success' });

    const root = completions[0]?.spans.find((span) => span.spanId === session.rootSpanId);
    expect(root?.attributes).toMatchObject({ [attributeName.fast]: true });
  });
});
