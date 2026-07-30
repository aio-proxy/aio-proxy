import { expect, test } from 'bun:test';

import type { BodyTapTerminal } from '.';
import { tapTextBody } from '.';

const encoder = new TextEncoder();

test('forwards bytes and reconstructs split UTF-8 text', async () => {
  const bytes = encoder.encode('前缀🙂后缀');
  const source = streamOf(bytes.slice(0, 8), bytes.slice(8, 10), bytes.slice(10));
  const chunks: string[] = [];
  const terminals: BodyTapTerminal[] = [];

  const returned = new Uint8Array(
    await new Response(
      tapTextBody(source, 'application/json', {
        chunk: (text) => chunks.push(text),
        terminal: (terminal) => terminals.push(terminal),
      }),
    ).arrayBuffer(),
  );

  expect(returned).toEqual(bytes);
  expect(chunks.join('')).toBe('前缀🙂后缀');
  expect(terminals).toEqual([{ byteLength: bytes.byteLength, outcome: 'complete' }]);
});

test('emits complete SSE frames across mixed line endings', async () => {
  const chunks: string[] = [];
  const text = 'event: first\r\ndata: 1\r\n\r\ndata: 2\n\ndata: tail';
  const tapped = tapTextBody(
    streamOf(encoder.encode(text.slice(0, 18)), encoder.encode(text.slice(18, 31)), encoder.encode(text.slice(31))),
    'text/event-stream; charset=utf-8',
    { chunk: (chunk) => chunks.push(chunk), terminal() {} },
  );

  expect(await new Response(tapped).text()).toBe(text);
  expect(chunks).toEqual(['event: first\r\ndata: 1\r\n\r\n', 'data: 2\n\n', 'data: tail']);
});

test('reports a split SSE frame on the source read that completes it', async () => {
  const sourceReads: number[] = [];
  const sseFrames: number[] = [];
  const first = encoder.encode('data: fir');
  const second = encoder.encode('st\n\n');
  const tapped = tapTextBody(streamOf(first, second), 'text/event-stream', {
    chunk() {},
    terminal() {},
    sourceRead: (byteLength) => sourceReads.push(byteLength),
    sseFrames: (count) => sseFrames.push(count),
  });

  expect(await new Response(tapped).text()).toBe('data: first\n\n');
  expect(sourceReads).toEqual([first.byteLength, second.byteLength]);
  expect(sseFrames).toEqual([0, 1]);
});

test('reports cancellation and preserves the source cancel reason', async () => {
  const terminals: BodyTapTerminal[] = [];
  let reason: unknown;
  const tapped = tapTextBody(
    new ReadableStream({
      cancel(value) {
        reason = value;
      },
    }),
    'application/json',
    { chunk() {}, terminal: (value) => terminals.push(value) },
  );

  await tapped.cancel('client-left');

  expect(reason).toBe('client-left');
  expect(terminals).toEqual([{ byteLength: 0, outcome: 'cancelled' }]);
});

test('cancels the source only once when cancellation is repeated', async () => {
  let cancellations = 0;
  const tapped = tapTextBody(
    new ReadableStream({
      cancel() {
        cancellations++;
      },
    }),
    'application/json',
    { chunk() {}, terminal() {} },
  );

  await tapped.cancel('client-left');
  await tapped.cancel('client-left-again');

  expect(cancellations).toBe(1);
});

test('reports the source error without changing it', async () => {
  const terminals: BodyTapTerminal[] = [];
  const failure = new Error('source failed');
  const tapped = tapTextBody(
    new ReadableStream({
      pull(controller) {
        controller.error(failure);
      },
    }),
    'application/json',
    { chunk() {}, terminal: (value) => terminals.push(value) },
  );

  await expect(new Response(tapped).text()).rejects.toBe(failure);
  expect(terminals).toEqual([{ byteLength: 0, error: failure, outcome: 'error' }]);
});

test('classifies an abort as cancellation only when the inbound signal aborted', async () => {
  const abortWith = async (signal?: AbortSignal) => {
    const terminals: BodyTapTerminal[] = [];
    const aborted = new DOMException('The operation was aborted', 'AbortError');
    const tapped = tapTextBody(
      new ReadableStream({
        pull(controller) {
          controller.error(aborted);
        },
      }),
      'text/event-stream',
      { chunk() {}, terminal: (value) => terminals.push(value) },
      signal,
    );
    await expect(new Response(tapped).text()).rejects.toBe(aborted);
    return { terminals, aborted };
  };

  const controller = new AbortController();
  controller.abort();
  const clientDisconnect = await abortWith(controller.signal);
  expect(clientDisconnect.terminals).toEqual([{ byteLength: 0, outcome: 'cancelled' }]);

  const upstreamAbort = await abortWith(new AbortController().signal);
  expect(upstreamAbort.terminals).toEqual([{ byteLength: 0, error: upstreamAbort.aborted, outcome: 'error' }]);

  const noSignal = await abortWith(undefined);
  expect(noSignal.terminals).toEqual([{ byteLength: 0, error: noSignal.aborted, outcome: 'error' }]);
});

test('observer failure never changes returned bytes', async () => {
  const bytes = encoder.encode('visible');
  const returned = await new Response(
    tapTextBody(streamOf(bytes), 'application/json', {
      chunk() {
        throw new Error('logger failed');
      },
      terminal() {},
    }),
  ).text();

  expect(returned).toBe('visible');
});

test('does not read or lock the source before a consumer requests bytes', async () => {
  let pulls = 0;
  const source = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );

  tapTextBody(source, 'application/json', { chunk() {}, terminal() {} });
  await Bun.sleep(0);

  expect(pulls).toBe(0);
  expect(source.locked).toBeFalse();
});

test('supports Request.clone without reading ahead', async () => {
  const original = new Request('https://upstream.test', { method: 'POST', body: 'visible' });
  const source = new Request(original).body;
  if (source === null) throw new Error('expected request body');
  const tapped = tapTextBody(source, 'application/json', { chunk() {}, terminal() {} });
  const request = new Request('https://upstream.test', { method: 'POST', body: tapped });

  const result = await Promise.race([request.clone().text(), Bun.sleep(100).then(() => 'TIMEOUT')]);

  expect(result).toBe('visible');
});

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}
