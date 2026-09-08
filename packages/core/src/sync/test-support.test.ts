import { expect, test } from 'bun:test';

import { exerciseSyncBackend } from '@aio-proxy/plugin-sdk/testing';

import { createMemorySyncBackend } from './test-support';

test('memory sync backend satisfies the public conformance exercise', async () => {
  const backend = createMemorySyncBackend();
  const a = backend.connect();
  const b = backend.connect();

  await exerciseSyncBackend(async () => ({
    a,
    b,
    async cleanup() {
      await Promise.allSettled([a.dispose(), b.dispose()]);
    },
  }));
});

test('memory backend persists a write before an outcome-unknown failure', async () => {
  const backend = createMemorySyncBackend();
  const session = backend.connect();
  const signal = new AbortController().signal;
  backend.failNext('compareAndSwap', 'after');

  await expect(session.compareAndSwap('key', null, new Uint8Array([1]), signal)).rejects.toMatchObject({
    code: 'outcome-unknown',
  });
  expect(await session.read('key', signal)).toMatchObject({ kind: 'present', value: new Uint8Array([1]) });
});
