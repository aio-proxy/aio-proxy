import { expect, test } from 'bun:test';

import { createCancellableEgressStream } from '../../src/egress/cancellable-stream';

test('downstream cancellation cancels the source reader exactly once', async () => {
  let cancelled: unknown;
  const source = new ReadableStream<number>({
    pull(controller) {
      controller.enqueue(1);
    },
    cancel(reason) {
      cancelled = reason;
    },
  });
  const output = createCancellableEgressStream(source, async ({ parts, enqueue }) => {
    for await (const part of parts) enqueue(new Uint8Array([part]));
  });

  const reader = output.getReader();
  await reader.read();
  await reader.cancel('client disconnected');

  expect(cancelled).toBe('client disconnected');
});

test('downstream cancellation is not blocked by a source waiting for more parts', async () => {
  let cancelled: unknown;
  const source = new ReadableStream<number>({
    start(controller) {
      controller.enqueue(1);
    },
    cancel(reason) {
      cancelled = reason;
    },
  });
  const output = createCancellableEgressStream(source, async ({ parts, enqueue }) => {
    for await (const part of parts) enqueue(new Uint8Array([part]));
  });

  const reader = output.getReader();
  await reader.read();
  await reader.cancel('client disconnected');

  expect(cancelled).toBe('client disconnected');
});

test('downstream cancellation waits for source cleanup before settling completion', async () => {
  const cleanup = Promise.withResolvers<void>();
  const cancelStarted = Promise.withResolvers<void>();
  let completionSettled = false;
  const source = new ReadableStream<number>({
    start(controller) {
      controller.enqueue(1);
    },
    async cancel() {
      cancelStarted.resolve();
      await cleanup.promise;
    },
  });
  const output = createCancellableEgressStream(source, async ({ parts, enqueue }) => {
    for await (const part of parts) enqueue(new Uint8Array([part]));
  });
  void output.completion.catch(() => {
    completionSettled = true;
  });

  const reader = output.getReader();
  await reader.read();
  const cancelled = reader.cancel('client disconnected');
  await cancelStarted.promise;
  await Promise.resolve();

  expect(completionSettled).toBe(false);
  expect(source.locked).toBe(true);
  cleanup.resolve();
  await cancelled;
  await expect(output.completion).rejects.toBe('client disconnected');
});

test('downstream cancellation preserves a source cancellation error', async () => {
  const cancelError = new Error('source cancel failed');
  const source = new ReadableStream<number>({
    start(controller) {
      controller.enqueue(1);
    },
    cancel() {
      throw cancelError;
    },
  });
  const output = createCancellableEgressStream(source, async ({ parts, enqueue }) => {
    for await (const part of parts) enqueue(new Uint8Array([part]));
  });

  const reader = output.getReader();
  await reader.read();

  await expect(reader.cancel('client disconnected')).rejects.toBe(cancelError);
  await expect(output.completion).rejects.toBe('client disconnected');
  expect(source.locked).toBe(false);
});

test('writer failure cancels the source once without replacing the writer error', async () => {
  const writerError = new Error('writer failed');
  const cleanup = Promise.withResolvers<void>();
  const cancelStarted = Promise.withResolvers<void>();
  let cancelCalls = 0;
  let completionSettled = false;
  const source = new ReadableStream<number>({
    start(controller) {
      controller.enqueue(1);
    },
    async cancel() {
      cancelCalls += 1;
      cancelStarted.resolve();
      await cleanup.promise;
    },
  });
  const output = createCancellableEgressStream(source, async ({ parts, enqueue }) => {
    for await (const part of parts) {
      enqueue(new Uint8Array([part]));
      throw writerError;
    }
  });
  void output.completion.catch(() => {
    completionSettled = true;
  });

  const reader = output.getReader();
  expect((await reader.read()).value).toEqual(new Uint8Array([1]));
  await cancelStarted.promise;
  await expect(reader.read()).rejects.toBe(writerError);
  await Promise.resolve();

  expect(completionSettled).toBe(false);
  cleanup.resolve();
  await expect(output.completion).rejects.toBe(writerError);

  expect(cancelCalls).toBe(1);
  expect(source.locked).toBe(false);
});

test('response body cancellation reaches a source waiting for more parts', async () => {
  let cancelCalls = 0;
  const source = new ReadableStream<number>({
    start(controller) {
      controller.enqueue(1);
    },
    cancel() {
      cancelCalls += 1;
    },
  });
  const output = createCancellableEgressStream(source, async ({ parts, enqueue }) => {
    for await (const part of parts) enqueue(new Uint8Array([part]));
  });

  const reader = new Response(output).body?.getReader();
  await reader?.read();
  await reader?.cancel('client disconnected');

  expect(cancelCalls).toBe(1);
});

test('response body cancellation reaches a preflighted source', async () => {
  let cancelCalls = 0;
  const upstream = new ReadableStream<number>({
    start(controller) {
      controller.enqueue(1);
    },
    cancel() {
      cancelCalls += 1;
    },
  });
  const upstreamReader = upstream.getReader();
  const first = await upstreamReader.read();
  if (first.done) throw new Error('expected first part');
  let firstPending = true;
  const source = new ReadableStream<number>({
    async pull(controller) {
      if (firstPending) {
        firstPending = false;
        controller.enqueue(first.value);
        return;
      }
      const next = await upstreamReader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return upstreamReader.cancel(reason);
    },
  });
  const output = createCancellableEgressStream(source, async ({ parts, enqueue }) => {
    for await (const part of parts) enqueue(new Uint8Array([part]));
  });

  const reader = new Response(output).body?.getReader();
  await reader?.read();
  await reader?.cancel('client disconnected');

  expect(cancelCalls).toBe(1);
});
