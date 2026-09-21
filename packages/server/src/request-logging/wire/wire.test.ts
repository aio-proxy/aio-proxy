import { expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';
import { context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { createObservedFetch, observeInboundRequest } from '.';
import { getTraceRuntime } from '../../request-tracing';
import {
  createAttemptResponseObservation,
  type AttemptResponseObservation,
  withAttemptResponseObservation,
} from '../../response-observation';
import type { ServerLog } from '../../server-log';
import { withAttemptLogContext, withRequestLogContext } from '../context';
import { captureFetch, type FetchCall, inDebugAttempt, reconstructed, terminals } from '../test-support';

test('non-debug fetch preserves the original input and init', async () => {
  const calls: FetchCall[] = [];
  const originalRequest = new Request('https://upstream.test/v1/responses');
  const init = { headers: { 'x-test': 'value' } };

  await createObservedFetch(captureFetch(calls, () => new Response(null, { status: 204 })))(originalRequest, init);

  expect(calls).toEqual([{ input: originalRequest, init }]);
});

test('observes controlled identity SSE without enabling debug body logs', async () => {
  const times = [10, 20, 25];
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => times.shift() ?? 25 });
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: one\n\ndata: two\n\n'));
      controller.close();
    },
  });
  const fetcher = createObservedFetch(
    async () => new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
  );

  const response = await withRequestLogContext({ requestId: 'quiet', debug: false, logger() {} }, () =>
    withAttemptResponseObservation(observation, () =>
      fetcher('https://upstream.test', { decompress: false } as RequestInit & { readonly decompress: false }),
    ),
  );
  await response.text();

  expect(observation.snapshot()).toEqual({
    transportObservation: 'sse',
    upstreamHeadersMs: 10,
    firstUpstreamByteMs: 20,
    firstSseEventMs: 25,
    maxSseFramesPerRead: 2,
    contentEncoding: 'identity',
    httpSends: 1,
  });
});

test('does not map compressed source reads to decoded SSE frames', async () => {
  const times = [10, 20, 25];
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => times.shift() ?? 25 });
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: encoded bytes\n\n'));
      controller.close();
    },
  });
  const fetcher = createObservedFetch(
    async () =>
      new Response(source, {
        headers: { 'content-encoding': 'gzip', 'content-type': 'text/event-stream' },
      }),
  );

  const response = await withAttemptResponseObservation(observation, () =>
    fetcher('https://upstream.test', { decompress: false } as RequestInit & { readonly decompress: false }),
  );
  await response.text();

  expect(observation.snapshot()).toEqual({
    transportObservation: 'sse',
    upstreamHeadersMs: 10,
    firstUpstreamByteMs: 20,
    contentEncoding: 'gzip',
    httpSends: 1,
  });
});

test('records non-stream headers without controlled body metrics', async () => {
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 10 });
  const fetcher = createObservedFetch(
    async () => new Response('body', { headers: { 'content-type': 'application/json' } }),
  );

  const response = await withAttemptResponseObservation(observation, () => fetcher('https://upstream.test'));
  await response.text();

  expect(observation.snapshot()).toEqual({ transportObservation: 'body', upstreamHeadersMs: 10, httpSends: 1 });
});

test('marks two resolved fetch responses as ambiguous', async () => {
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 10 });
  const fetcher = createObservedFetch(async () => new Response('body'));

  await withAttemptResponseObservation(observation, async () => {
    await fetcher('https://upstream.test/one');
    await fetcher('https://upstream.test/two');
  });

  // 同一 attempt 内两次 fetch —— httpSends 数到 2 正是同 provider 重试的可见证据。
  expect(observation.snapshot()).toEqual({ transportObservation: 'ambiguous', httpSends: 2 });
});

test('does not let response metric failures alter the fetch response', async () => {
  const metricFailure = new Error('metric failed');
  const observation: AttemptResponseObservation = {
    markTransportUnavailable() {},
    observeContent: () => 0,
    observeFetchStart() {},
    observeResponse() {
      throw metricFailure;
    },
    observeSseEvent() {},
    snapshot: () => ({}),
  };
  const fetcher = createObservedFetch(async () => new Response('visible'));

  const response = await withAttemptResponseObservation(observation, () => fetcher('https://upstream.test'));

  expect(await response.text()).toBe('visible');
});

test('does not treat empty controlled chunks as the first upstream byte', async () => {
  const times = [10, 20, 25];
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => times.shift() ?? 25 });
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array());
      controller.enqueue(new TextEncoder().encode('data: one\n\n'));
      controller.close();
    },
  });
  const fetcher = createObservedFetch(
    async () => new Response(source, { headers: { 'content-type': 'text/event-stream' } }),
  );

  const response = await withAttemptResponseObservation(observation, () =>
    fetcher('https://upstream.test', { decompress: false } as RequestInit & { readonly decompress: false }),
  );
  await response.text();

  expect(observation.snapshot()).toMatchObject({ firstUpstreamByteMs: 20 });
});

test('non-debug inbound observation preserves Request identity', () => {
  const request = new Request('https://proxy.test/v1/responses');

  expect(observeInboundRequest(request, 'openai-response')).toBe(request);
  expect(
    withRequestLogContext({ requestId: 'quiet', debug: false, logger() {} }, () =>
      observeInboundRequest(request, 'openai-response'),
    ),
  ).toBe(request);
});

test('debug inbound observation does not tap openai-video bodies', async () => {
  const logs: ServerLog[] = [];
  const sentinel = 'data:image/png;base64,VIDEO_DATA_URL_SENTINEL';
  const request = new Request('https://proxy.test/v1/videos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'a cat', input_reference: { image_url: sentinel } }),
  });

  const observed = withRequestLogContext(
    { requestId: 'request-1', debug: true, logger: (entry) => logs.push(entry) },
    () => observeInboundRequest(request, 'openai-video'),
  );

  expect(observed).toBe(request);
  expect(await observed.text()).toContain(sentinel);
  expect(JSON.stringify(logs)).not.toContain(sentinel);
  expect(logs).toContainEqual(
    expect.objectContaining({ event: 'request.inbound_snapshot', inboundProtocol: 'openai-video' }),
  );
});

test('debug fetch does not tap openai-video request bodies', async () => {
  const logs: ServerLog[] = [];
  const sentinel = 'data:image/png;base64,VIDEO_DATA_URL_SENTINEL';
  const fetcher = createObservedFetch((async (input) => {
    if (!(input instanceof Request)) throw new TypeError('expected Request');
    expect(await input.text()).toContain(sentinel);
    return Response.json({ id: 'video_abc' });
  }) as typeof globalThis.fetch);

  await withRequestLogContext({ requestId: 'request-1', debug: true, logger: (entry) => logs.push(entry) }, () =>
    withAttemptLogContext(
      {
        attemptIndex: 0,
        providerId: 'openai',
        modelId: 'sora-2',
        requestedModelId: 'sora-2',
        sourceProtocol: ProviderProtocol.OpenAIVideo,
      },
      () =>
        fetcher(
          new Request('https://upstream.test/v1/videos', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: 'a cat', input_reference: { image_url: sentinel } }),
          }),
        ),
    ),
  );

  expect(JSON.stringify(logs)).not.toContain(sentinel);
  expect(reconstructed(logs, 'upstream_request')).toBe('');
  expect(reconstructed(logs, 'upstream_response')).toBe('');
  expect(terminals(logs, 'upstream_response')).toEqual([
    expect.objectContaining({ outcome: 'complete', byteLength: 0, direction: 'upstream_response' }),
  ]);
});

test('debug inbound observation logs complete consumed input', async () => {
  const logs: ServerLog[] = [];
  const request = new Request('https://proxy.test/v1/responses?api_key=query-secret', {
    method: 'POST',
    headers: { authorization: 'hidden', 'content-type': 'application/json', 'x-client': 'visible' },
    body: '{"input":"visible-input","token":"visible-body-token"}',
  });

  const observed = withRequestLogContext(
    { requestId: 'request-1', debug: true, logger: (entry) => logs.push(entry) },
    () => observeInboundRequest(request, 'openai-response'),
  );

  expect(await observed.text()).toBe('{"input":"visible-input","token":"visible-body-token"}');
  expect(reconstructed(logs, 'inbound')).toBe('{"input":"visible-input","token":"visible-body-token"}');
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: 'request.inbound_snapshot',
      url: 'https://proxy.test/v1/responses?api_key=%5BREDACTED%5D',
      headers: expect.objectContaining({ authorization: '[REDACTED]', 'x-client': 'visible' }),
    }),
  );
});

test('debug fetch logs complete delegated request and consumed response', async () => {
  const logs: ServerLog[] = [];
  const delegatedBodies: string[] = [];
  const fetcher = createObservedFetch((async (input, init) => {
    if (!(input instanceof Request)) throw new TypeError('expected observed Request');
    expect(init).toEqual({ decompress: false });
    delegatedBodies.push(await input.text());
    return new Response('{"output":"response-visible"}', {
      headers: { 'content-type': 'application/json', 'x-result': 'visible-header' },
    });
  }) as typeof globalThis.fetch);

  const response = await inDebugAttempt(logs, () =>
    fetcher(
      new Request('https://upstream.test/v1/responses?token=query-secret', {
        method: 'POST',
        headers: {
          authorization: 'Bearer hidden',
          'content-type': 'application/json',
          'x-observable': 'visible-header',
        },
        body: '{"input":"request-visible","token":"body-visible"}',
      }),
      { decompress: false } as RequestInit & { readonly decompress: false },
    ),
  );

  expect(await response.text()).toBe('{"output":"response-visible"}');
  expect(delegatedBodies).toEqual(['{"input":"request-visible","token":"body-visible"}']);
  expect(reconstructed(logs, 'upstream_request')).toBe('{"input":"request-visible","token":"body-visible"}');
  expect(reconstructed(logs, 'upstream_response')).toBe('{"output":"response-visible"}');
  expect(terminals(logs, 'upstream_request')).toEqual([
    expect.objectContaining({ outcome: 'complete', attemptIndex: 2 }),
  ]);
  expect(terminals(logs, 'upstream_response')).toEqual([
    expect.objectContaining({ outcome: 'complete', attemptIndex: 2 }),
  ]);
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: 'request.upstream_snapshot',
      url: 'https://upstream.test/v1/responses?token=%5BREDACTED%5D',
      headers: expect.objectContaining({ authorization: '[REDACTED]', 'x-observable': 'visible-header' }),
    }),
  );
  expect(logs).toContainEqual(
    expect.objectContaining({
      event: 'request.upstream_result',
      outcome: 'response',
      headers: expect.objectContaining({ 'x-result': 'visible-header' }),
    }),
  );
});

test('debug fetch numbers each HTTP send inside one attempt', async () => {
  const logs: ServerLog[] = [];
  const fetcher = createObservedFetch((async () => new Response('ok')) as typeof globalThis.fetch);

  await inDebugAttempt(logs, async () => {
    await fetcher(new Request('https://upstream.test/v1/a'));
    await fetcher(new Request('https://upstream.test/v1/b'));
  });

  expect(logs.filter((entry) => entry.event === 'request.upstream_snapshot')).toEqual([
    expect.objectContaining({ event: 'request.upstream_snapshot', sendIndex: 0 }),
    expect.objectContaining({ event: 'request.upstream_snapshot', sendIndex: 1 }),
  ]);
  expect(logs.filter((entry) => entry.event === 'request.upstream_result')).toEqual([
    expect.objectContaining({ event: 'request.upstream_result', sendIndex: 0 }),
    expect.objectContaining({ event: 'request.upstream_result', sendIndex: 1 }),
  ]);
});

test('debug fetch keeps send indexes across separate inAttempt entries', async () => {
  const logs: ServerLog[] = [];
  const fetcher = createObservedFetch((async () => new Response(null, { status: 204 })) as typeof globalThis.fetch);
  const attempt = {
    attemptIndex: 0,
    providerId: 'provider-a',
    modelId: 'model-a',
  } as const;

  await withRequestLogContext(
    { requestId: 'request-1', debug: true, logger: (entry) => logs.push(entry) },
    async () => {
      await withAttemptLogContext(attempt, () => fetcher(new Request('https://upstream.test/v1/a')));
      await withAttemptLogContext(attempt, () => fetcher(new Request('https://upstream.test/v1/b')));
    },
  );

  expect(logs.filter((entry) => entry.event === 'request.upstream_snapshot')).toEqual([
    expect.objectContaining({ sendIndex: 0 }),
    expect.objectContaining({ sendIndex: 1 }),
  ]);
});

test('debug fetch preserves the thrown transport error', async () => {
  const logs: ServerLog[] = [];
  const failure = Object.assign(new Error('offline'), { code: 'ConnectionRefused' });

  await expect(
    inDebugAttempt(logs, () =>
      createObservedFetch((async () => {
        throw failure;
      }) as typeof globalThis.fetch)('https://upstream.test/v1/responses'),
    ),
  ).rejects.toBe(failure);

  expect(logs).toContainEqual(
    expect.objectContaining({
      event: 'request.upstream_result',
      outcome: 'exception',
      exceptionCode: 'ConnectionRefused',
    }),
  );
});

test('upstream fetch opens a CLIENT span under the active span', async () => {
  const { processor, tracer } = getTraceRuntime();
  const parent = tracer.startSpan('test.attempt');
  const traceId = parent.spanContext().traceId;
  // The processor only buffers traces it was told about; an unregistered trace
  // is dropped on end and take() would come back empty.
  processor.register(traceId);
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 10 });
  const fetcher = createObservedFetch(async () => new Response(null, { status: 503 }));

  await context.with(trace.setSpan(context.active(), parent), () =>
    withAttemptResponseObservation(observation, () => fetcher('https://upstream.test/v1/chat?key=secret')),
  );
  parent.end();

  const spans = processor.take(traceId);
  const post = spans.find((span) => span.name === 'GET');
  expect(post?.kind).toBe(SpanKind.CLIENT);
  expect(post?.parentSpanId).toBe(parent.spanContext().spanId);
  expect(post?.attributes).toMatchObject({
    'http.request.method': 'GET',
    'server.address': 'upstream.test',
    'url.path': '/v1/chat',
    'http.response.status_code': 503,
  });
  expect(JSON.stringify(post?.attributes)).not.toContain('secret');
  // 4xx/5xx 的响应也要把 CLIENT span 标成 ERROR —— 只记状态码的话，外部追踪后端会把一次
  // 失败的上游调用显示成成功的，而它的父 attempt 明明是失败的。语义约定里 SERVER span 的
  // 4xx 保持 UNSET 是另一回事，不适用于发起方。
  expect(post?.statusCode).toBe(SpanStatusCode.ERROR);
});

test('an upstream response that succeeded leaves the CLIENT span unset', async () => {
  const { processor, tracer } = getTraceRuntime();
  const parent = tracer.startSpan('test.attempt');
  const traceId = parent.spanContext().traceId;
  processor.register(traceId);
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 10 });
  const fetcher = createObservedFetch(async () => new Response(null, { status: 200 }));

  await context.with(trace.setSpan(context.active(), parent), () =>
    withAttemptResponseObservation(observation, () => fetcher('https://upstream.test/v1/chat')),
  );
  parent.end();

  // 没有这条，「4xx/5xx 设 ERROR」那句可以用无条件 setStatus(ERROR) 蒙混过关。
  const post = processor.take(traceId).find((span) => span.name === 'GET');
  expect(post?.attributes['http.response.status_code']).toBe(200);
  expect(post?.statusCode).not.toBe(SpanStatusCode.ERROR);
});

test('the upstream span is named after the request method, normalized', async () => {
  const { processor, tracer } = getTraceRuntime();
  const parent = tracer.startSpan('test.attempt');
  const traceId = parent.spanContext().traceId;
  processor.register(traceId);
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 10 });
  const fetcher = createObservedFetch(async () => new Response(null, { status: 200 }));

  await context.with(trace.setSpan(context.active(), parent), () =>
    withAttemptResponseObservation(observation, async () => {
      // Every real model call arrives as a POST Request object, never the bare
      // URL the other tests here use.
      await fetcher(new Request('https://upstream.test/v1/messages', { method: 'POST' }));
      // An explicit init method wins over the input, and is upcased.
      await fetcher('https://upstream.test/v1/models', { method: 'patch' });
    }),
  );
  parent.end();

  const spans = processor.take(traceId);
  expect(spans.find((span) => span.name === 'POST')?.attributes).toMatchObject({
    'http.request.method': 'POST',
    'url.path': '/v1/messages',
  });
  expect(spans.find((span) => span.name === 'PATCH')?.attributes).toMatchObject({
    'http.request.method': 'PATCH',
    'url.path': '/v1/models',
  });
});

// URL 认证是真实形状（Google 的 ?key=、各家的 ?api_key=），而 header 那份名单保护不到它。
// 抓包接口把记下的 URL 原样送进浏览器，所以这里漏一个就是把可直接冒用的凭据交出去。
test('redacts credential query parameters from captured urls', async () => {
  const logs: ServerLog[] = [];
  const request = new Request(
    'https://proxy.test/v1/responses?api_key=query-secret&access_token=tok-secret&sig=sig-secret&keyword=visible&stream=true',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );

  withRequestLogContext({ requestId: 'request-1', debug: true, logger: (entry) => logs.push(entry) }, () =>
    observeInboundRequest(request, 'openai-response'),
  );

  const snapshot = JSON.stringify(logs.find((entry) => entry.event === 'request.inbound_snapshot'));
  expect(snapshot).not.toContain('query-secret');
  expect(snapshot).not.toContain('tok-secret');
  expect(snapshot).not.toContain('sig-secret');
  // 按词匹配而不是整串包含：`keyword` 里有 key，但它不是凭据，误脱了调试就难查。
  expect(snapshot).toContain('keyword=visible');
  expect(snapshot).toContain('stream=true');
});

// server.address 只放主机名：带端口的 `provider.example:8443` 不是合法值，按标准聚合的
// 后端会认不出来。端口单独走 server.port，走默认端口时干脆不发 —— 补一个猜出来的默认值
// 等于把「没说」写成「说了」。
test('splits the upstream port out of server.address', async () => {
  const { processor, tracer } = getTraceRuntime();
  const parent = tracer.startSpan('test.attempt');
  const traceId = parent.spanContext().traceId;
  processor.register(traceId);
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 10 });
  const fetcher = createObservedFetch(async () => new Response(null, { status: 200 }));

  await context.with(trace.setSpan(context.active(), parent), () =>
    withAttemptResponseObservation(observation, () => fetcher('https://provider.example:8443/v1/chat')),
  );
  parent.end();

  const post = processor.take(traceId).find((span) => span.name === 'GET');
  expect(post?.attributes['server.address']).toBe('provider.example');
  expect(post?.attributes['server.port']).toBe(8443);
});

test('omits server.port on the default port and unwraps an IPv6 address', async () => {
  const { processor, tracer } = getTraceRuntime();
  const parent = tracer.startSpan('test.attempt');
  const traceId = parent.spanContext().traceId;
  processor.register(traceId);
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 10 });
  const fetcher = createObservedFetch(async () => new Response(null, { status: 200 }));

  await context.with(trace.setSpan(context.active(), parent), () =>
    withAttemptResponseObservation(observation, () => fetcher('https://[::1]/v1/chat')),
  );
  parent.end();

  const post = processor.take(traceId).find((span) => span.name === 'GET');
  // 方括号是 URL 语法，不属于地址本身。
  expect(post?.attributes['server.address']).toBe('::1');
  expect(post?.attributes['server.port']).toBeUndefined();
});
