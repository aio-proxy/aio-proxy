import { expect, test } from 'bun:test';

import {
  MAX_GROK_FILE_BYTES,
  readBoundedStream,
  readOpenFileText,
  withHandleBudget,
  withReadBudget,
  type ReadableFileHandle,
} from './read-bounded';

test('an oversized handle is rejected before reading', async () => {
  let reads = 0;
  const handle: ReadableFileHandle = {
    async read() {
      reads += 1;
      return { bytesRead: 0 };
    },
    async close() {},
  };
  await expect(
    readOpenFileText(handle, MAX_GROK_FILE_BYTES + 1, {
      maxBytes: MAX_GROK_FILE_BYTES,
      limitError: () => new Error('limit'),
    }),
  ).rejects.toThrow('limit');
  expect(reads).toBe(0);
});

test('a stalled operation fails within the remaining budget', async () => {
  const started = Date.now();
  await expect(
    withReadBudget(
      { deadline: Date.now() + 80, signal: AbortSignal.timeout(80) },
      () => new Error('limit'),
      () => new Promise<never>(() => {}),
    ),
  ).rejects.toThrow('limit');
  expect(Date.now() - started).toBeLessThan(1_000);
});

test('an expired budget is rejected before reading', async () => {
  let reads = 0;
  const handle: ReadableFileHandle = {
    async read() {
      reads += 1;
      return { bytesRead: 0 };
    },
    async close() {},
  };
  await expect(
    readOpenFileText(handle, 4, {
      maxBytes: MAX_GROK_FILE_BYTES,
      budget: { deadline: Date.now() - 1, signal: AbortSignal.timeout(5_000) },
      limitError: () => new Error('limit'),
    }),
  ).rejects.toThrow('limit');
  expect(reads).toBe(0);
});

test('a stalled handle operation fails without awaiting close', async () => {
  let closed = 0;
  const started = Date.now();
  await expect(
    withHandleBudget(
      {
        close: async () => {
          closed += 1;
          await new Promise(() => {});
        },
      },
      { deadline: Date.now() + 80, signal: AbortSignal.timeout(80) },
      () => new Error('limit'),
      () => new Promise<never>(() => {}),
    ),
  ).rejects.toThrow('limit');
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(closed).toBeGreaterThan(0);
});

test('abort closes the handle so a stalled read fails within the budget', async () => {
  let closed = 0;
  const handle: ReadableFileHandle = {
    async read() {
      await new Promise<void>((_resolve, reject) => {
        const timer = setInterval(() => {
          if (closed === 0) return;
          clearInterval(timer);
          reject(Object.assign(new Error('EBADF'), { code: 'EBADF' }));
        }, 5);
      });
      return { bytesRead: 0 };
    },
    async close() {
      closed += 1;
    },
  };
  const started = Date.now();
  await expect(
    readOpenFileText(handle, 32, {
      maxBytes: MAX_GROK_FILE_BYTES,
      budget: { deadline: Date.now() + 80, signal: AbortSignal.timeout(80) },
      limitError: () => new Error('limit'),
    }),
  ).rejects.toThrow('limit');
  expect(Date.now() - started).toBeLessThan(1_000);
  expect(closed).toBeGreaterThan(0);
});

test('a stream is rejected once it exceeds the byte cap', async () => {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8).fill(97));
      controller.enqueue(new Uint8Array(8).fill(98));
      controller.close();
    },
  });
  await expect(
    readBoundedStream(stream, {
      maxBytes: 10,
      limitError: () => new Error('limit'),
    }),
  ).rejects.toThrow('limit');
});
