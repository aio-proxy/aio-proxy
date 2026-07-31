import { expect, test } from 'bun:test';

import { createObservedFetch, observeInboundRequest } from '.';
import {
  createAttemptResponseObservation,
  type AttemptResponseObservation,
  withAttemptResponseObservation,
} from '../../response-observation';
import type { ServerLog } from '../../server-log';
import { withRequestLogContext } from '../context';
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
  });
});

test('records non-stream headers without controlled body metrics', async () => {
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 10 });
  const fetcher = createObservedFetch(
    async () => new Response('body', { headers: { 'content-type': 'application/json' } }),
  );

  const response = await withAttemptResponseObservation(observation, () => fetcher('https://upstream.test'));
  await response.text();

  expect(observation.snapshot()).toEqual({ transportObservation: 'body', upstreamHeadersMs: 10 });
});

test('marks two resolved fetch responses as ambiguous', async () => {
  const observation = createAttemptResponseObservation({ startedAt: 0, now: () => 10 });
  const fetcher = createObservedFetch(async () => new Response('body'));

  await withAttemptResponseObservation(observation, async () => {
    await fetcher('https://upstream.test/one');
    await fetcher('https://upstream.test/two');
  });

  expect(observation.snapshot()).toEqual({ transportObservation: 'ambiguous' });
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

test('debug inbound observation logs complete consumed input', async () => {
  const logs: ServerLog[] = [];
  const request = new Request('https://proxy.test/v1/responses?api_key=visible-query', {
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
      url: 'https://proxy.test/v1/responses?api_key=visible-query',
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
      new Request('https://upstream.test/v1/responses?token=visible-query', {
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
      url: 'https://upstream.test/v1/responses?token=visible-query',
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
