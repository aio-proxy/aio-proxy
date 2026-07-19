import { expect, test } from "bun:test";

import { preflightCcaSse, unwrapCcaSse } from "./stream";

const modelEvent = 'data: {"response":{"candidates":[]}}\n\n';
const sseBufferLimit = 1024 * 1024;

test.each([
  ["JSON parse failure", "data: not-json\n\n"],
  ["parser onError", "invalid-field: value\n\n"],
] as const)("cancels and releases the source reader after %s", async (_label, event) => {
  const source = instrumentedBody([{ chunk: event }]);

  const failure = await rejected(new Response(unwrapCcaSse(source.body)).text());

  expect(failure).toBeInstanceOf(Error);
  expect(source.cancellations).toEqual([failure]);
  expect(source.releases()).toBe(1);
});

test("cancels and releases the source reader when unwrap reading fails", async () => {
  const failure = new Error("reader failed");
  const source = instrumentedBody([{ failure }]);

  await expect(new Response(unwrapCcaSse(source.body)).text()).rejects.toBe(failure);

  expect(source.cancellations).toEqual([failure]);
  expect(source.releases()).toBe(1);
});

test("releases the source reader without cancellation after normal unwrap EOF", async () => {
  const source = instrumentedBody([{ chunk: modelEvent }, { done: true }]);

  const body = await new Response(unwrapCcaSse(source.body)).text();

  expect(body).toBe('data: {"candidates":[]}\n\n');
  expect(source.cancellations).toEqual([]);
  expect(source.releases()).toBe(1);
});

test("cancels and releases the source reader after downstream unwrap cancellation", async () => {
  const reason = { kind: "downstream-cancel" };
  const source = instrumentedBody([]);
  const output = unwrapCcaSse(source.body);

  await output.cancel(reason);

  expect(source.cancellations).toEqual([reason]);
  expect(source.releases()).toBe(1);
});

test("cancels and releases the source reader when preflight fails", async () => {
  const failure = new Error("reader failed");
  const source = instrumentedBody([{ failure }]);
  const response = new Response(source.body, { headers: { "Content-Type": "text/event-stream" } });

  await expect(preflightCcaSse(response)).rejects.toBe(failure);

  expect(source.cancellations).toEqual([failure]);
  expect(source.releases()).toBe(1);
});

test("preflight replay cancellation reaches and releases the source reader", async () => {
  const reason = { kind: "replay-cancel" };
  const source = instrumentedBody([{ chunk: modelEvent }]);
  const response = new Response(source.body, { headers: { "Content-Type": "text/event-stream" } });

  const preflight = await preflightCcaSse(response);
  await preflight.response.body?.cancel(reason);

  expect(source.cancellations).toEqual([reason]);
  expect(source.releases()).toBe(1);
});

test("bounds replay across valid unclassified preflight events", async () => {
  const readBeyondLimit = new Error("read beyond replay limit");
  const source = instrumentedBody([
    ...Array.from({ length: 17 }, () => ({ chunk: unclassifiedEvent(64 * 1024) })),
    { failure: readBeyondLimit },
  ]);
  const response = new Response(source.body, { headers: { "Content-Type": "text/event-stream" } });

  const failure = await rejected(preflightCcaSse(response));

  expectInvalidStream(failure);
  expect(failure).not.toBe(readBeyondLimit);
  expect(source.cancellations).toEqual([failure]);
  expect(source.releases()).toBe(1);
});

test("bounds an unterminated preflight event before another read", async () => {
  const readBeyondLimit = new Error("read beyond parser limit");
  const source = instrumentedBody([{ chunk: `data: ${"x".repeat(sseBufferLimit + 1)}` }, { failure: readBeyondLimit }]);
  const response = new Response(source.body, { headers: { "Content-Type": "text/event-stream" } });

  const failure = await rejected(preflightCcaSse(response));

  expectInvalidStream(failure);
  expect(failure).not.toBe(readBeyondLimit);
  expect(source.cancellations).toEqual([failure]);
  expect(source.releases()).toBe(1);
});

test("bounds a single oversized unwrap event", async () => {
  const event = `data: ${JSON.stringify({ response: { text: "x".repeat(sseBufferLimit) } })}\n\n`;
  const source = instrumentedBody([{ chunk: event }]);

  const failure = await rejected(new Response(unwrapCcaSse(source.body)).text());

  expectInvalidStream(failure);
  expect(source.cancellations).toEqual([failure]);
  expect(source.releases()).toBe(1);
});

test("bounds queued unwrap frames from one upstream chunk", async () => {
  const event = `data: ${JSON.stringify({ response: { text: "x".repeat(64 * 1024) } })}\n\n`;
  const source = instrumentedBody([{ chunk: event.repeat(17) }]);

  const failure = await rejected(new Response(unwrapCcaSse(source.body)).text());

  expectInvalidStream(failure);
  expect(source.cancellations).toEqual([failure]);
  expect(source.releases()).toBe(1);
});

type ReaderStep = { readonly chunk: string } | { readonly done: true } | { readonly failure: unknown };

function instrumentedBody(steps: readonly ReaderStep[]) {
  const cancellations: unknown[] = [];
  let index = 0;
  let releases = 0;
  const reader = {
    read: async () => {
      const step = steps[index++] ?? { done: true as const };
      if ("failure" in step) throw step.failure;
      if ("chunk" in step) return { done: false as const, value: new TextEncoder().encode(step.chunk) };
      return { done: true as const, value: undefined };
    },
    cancel: async (reason?: unknown) => {
      cancellations.push(reason);
    },
    releaseLock: () => {
      releases += 1;
    },
  };
  const body = new ReadableStream<Uint8Array>();
  Object.defineProperty(body, "getReader", { value: () => reader });
  return { body, cancellations, releases: () => releases };
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection");
}

function unclassifiedEvent(padding: number): string {
  return `data: ${JSON.stringify({ metadata: "x".repeat(padding) })}\n\n`;
}

function expectInvalidStream(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("Google Antigravity returned an invalid event stream");
}
