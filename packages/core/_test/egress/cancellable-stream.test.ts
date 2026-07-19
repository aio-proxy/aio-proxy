import { expect, test } from "bun:test";

import { createCancellableEgressStream } from "../../src/egress/cancellable-stream";

test("downstream cancellation cancels the source reader exactly once", async () => {
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
  await reader.cancel("client disconnected");

  expect(cancelled).toBe("client disconnected");
});

test("downstream cancellation is not blocked by a source waiting for more parts", async () => {
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
  await reader.cancel("client disconnected");

  expect(cancelled).toBe("client disconnected");
});

test("response body cancellation reaches a source waiting for more parts", async () => {
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
  await reader?.cancel("client disconnected");

  expect(cancelCalls).toBe(1);
});

test("response body cancellation reaches a preflighted source", async () => {
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
  if (first.done) throw new Error("expected first part");
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
  await reader?.cancel("client disconnected");

  expect(cancelCalls).toBe(1);
});
