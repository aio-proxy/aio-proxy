import { expect, test } from 'bun:test';

import { classifyOpenAIResponsesRawRetry } from '@aio-proxy/core';

import { preflightRawRetrySse, readBoundedJsonBody } from './raw-retry';

const created =
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n';
const itemAdded = 'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0}\n\n';
const encryptedError =
  'event: error\ndata: {"type":"error","error":{"type":"invalid_request_error","code":"invalid_encrypted_content","message":"x"}}\n\n';
const otherError = 'event: error\ndata: {"type":"error","error":{"code":"invalid_value"}}\n\n';
const delta = 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}}\n\n';

function sse(text: string): Response {
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function live(): { readonly signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

function heldStream(chunk: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(chunk));
    },
  });
}

test('holds lifecycle frames then reports retry', async () => {
  const preflight = await preflightRawRetrySse(sse(created + encryptedError), classifyOpenAIResponsesRawRetry, live());
  expect(preflight.kind).toBe('retry');
  expect(await preflight.response.text()).toBe(created + encryptedError);
});

test('still retries when output_item.added precedes the error', async () => {
  const preflight = await preflightRawRetrySse(
    sse(created + itemAdded + encryptedError),
    classifyOpenAIResponsesRawRetry,
    live(),
  );
  expect(preflight.kind).toBe('retry');
});

test('commits when content arrives before the error', async () => {
  const preflight = await preflightRawRetrySse(
    sse(created + itemAdded + delta + encryptedError),
    classifyOpenAIResponsesRawRetry,
    live(),
  );
  expect(preflight.kind).toBe('commit');
  expect(await preflight.response.text()).toBe(created + itemAdded + delta + encryptedError);
});

test('commits other SSE errors', async () => {
  const preflight = await preflightRawRetrySse(sse(created + otherError), classifyOpenAIResponsesRawRetry, live());
  expect(preflight.kind).toBe('commit');
});

test('commits a stream that only ever holds', async () => {
  const preflight = await preflightRawRetrySse(sse(created + itemAdded), classifyOpenAIResponsesRawRetry, live());
  expect(preflight.kind).toBe('commit');
  expect(await preflight.response.text()).toBe(created + itemAdded);
});

// One provider-controlled chunk can carry both the padding and the retryable
// error. The cap has to win, otherwise the replay bound is unenforceable.
test('commits when a single oversized chunk also carries the retryable error', async () => {
  const padding = `event: response.output_item.added\ndata: {"type":"response.output_item.added","note":"${'x'.repeat(1024 * 1024 + 16)}"}\n\n`;
  const preflight = await preflightRawRetrySse(
    sse(created + padding + encryptedError),
    classifyOpenAIResponsesRawRetry,
    live(),
  );
  expect(preflight.kind).toBe('commit');
});

test('passes a non-event-stream body through without reading it', async () => {
  const response = Response.json({ ok: true });
  const preflight = await preflightRawRetrySse(response, classifyOpenAIResponsesRawRetry, live());
  expect(preflight.kind).toBe('commit');
  expect(preflight.response).toBe(response);
  expect(await preflight.response.json()).toEqual({ ok: true });
});

// raw.ts infers the SSE header only after this resolver, so a streaming provider
// that omits Content-Type must still be inspected.
test('treats a missing content type as SSE when a stream was requested', async () => {
  const response = new Response(created + encryptedError, { status: 200 });
  const preflight = await preflightRawRetrySse(response, classifyOpenAIResponsesRawRetry, {
    signal: new AbortController().signal,
    assumeEventStream: true,
  });
  expect(preflight.kind).toBe('retry');
});

test('does not inspect a missing content type without assumeEventStream', async () => {
  const response = new Response(created + encryptedError, { status: 200 });
  const preflight = await preflightRawRetrySse(response, classifyOpenAIResponsesRawRetry, live());
  expect(preflight.kind).toBe('commit');
  expect(preflight.response).toBe(response);
});

// An explicit non-SSE header still wins, so a JSON body is never drained here.
test('honors an explicit non-SSE content type even when a stream was requested', async () => {
  const response = Response.json({ ok: true });
  const preflight = await preflightRawRetrySse(response, classifyOpenAIResponsesRawRetry, {
    signal: new AbortController().signal,
    assumeEventStream: true,
  });
  expect(preflight.kind).toBe('commit');
  expect(preflight.response).toBe(response);
});

test('rejects a stream that stalls after a hold frame', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(created));
    },
    cancel() {
      cancelled = true;
    },
  });
  const response = new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });

  await expect(
    preflightRawRetrySse(response, classifyOpenAIResponsesRawRetry, {
      signal: new AbortController().signal,
      idleTimeoutMs: 10,
    }),
  ).rejects.toThrow();
  expect(cancelled).toBe(true);
});

// The abort must land while reader.read() is already pending: polling
// signal.aborted between reads would wait for upstream data or the idle timer.
test('rejects a delayed abort while the next read is pending', async () => {
  const controller = new AbortController();
  const response = new Response(heldStream(created), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
  const pending = preflightRawRetrySse(response, classifyOpenAIResponsesRawRetry, {
    signal: controller.signal,
    idleTimeoutMs: 60_000,
  });
  await Bun.sleep(20);
  controller.abort();
  await expect(pending).rejects.toThrow();
});

test('reads a bounded JSON error body', async () => {
  const response = Response.json({ error: { code: 'invalid_encrypted_content' } }, { status: 400 });
  expect(await readBoundedJsonBody(response, live())).toBe('{"error":{"code":"invalid_encrypted_content"}}');
});

test('refuses a non-JSON body', async () => {
  const response = new Response('<html>gateway error</html>', {
    status: 400,
    headers: { 'content-type': 'text/html' },
  });
  expect(await readBoundedJsonBody(response, live())).toBeUndefined();
  expect(await response.text()).toBe('<html>gateway error</html>');
});

test('refuses an oversized JSON body', async () => {
  const huge = `{"error":{"message":"${'x'.repeat(1024 * 1024 + 16)}"}}`;
  const response = new Response(huge, { status: 400, headers: { 'content-type': 'application/json' } });
  expect(await readBoundedJsonBody(response, live())).toBeUndefined();
});

// The cloned inspection branch must be abandoned without awaiting the tee-wide
// cancellation: the preserved original branch is never drained here, so an
// awaited cancel would never settle.
test('resolves an oversized JSON read while the original body is still open', async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoder.encode('x'.repeat(256 * 1024)));
    },
  });
  const response = new Response(body, { status: 400, headers: { 'content-type': 'application/json' } });

  const read = await Promise.race([
    readBoundedJsonBody(response, live()),
    Bun.sleep(1_000).then(() => 'timed-out' as const),
  ]);

  expect(read).toBeUndefined();
});

// A size or idle limit means "cannot intercept". An inbound abort is different:
// it must reach handleAttemptError so the request records `cancelled`.
test('rethrows an inbound abort during the JSON read', async () => {
  const controller = new AbortController();
  const response = new Response(heldStream('{"error":'), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
  const pending = readBoundedJsonBody(response, { signal: controller.signal, idleTimeoutMs: 60_000 });
  await Bun.sleep(20);
  controller.abort();
  await expect(pending).rejects.toThrow();
});

test('refuses a JSON body that stalls', async () => {
  const response = new Response(heldStream('{"error":'), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
  expect(
    await readBoundedJsonBody(response, { signal: new AbortController().signal, idleTimeoutMs: 10 }),
  ).toBeUndefined();
});
