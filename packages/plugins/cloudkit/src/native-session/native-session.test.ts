import { expect, test } from 'bun:test';

import { connectNative } from './native-session';
import { withFakeNative } from './test-support';

test('native exit during CAS reports outcome unknown', async () => {
  await withFakeNative('exit-after-write', async (executable) => {
    const signal = new AbortController().signal;
    const session = await connectNative({ executable, containerId: 'test', signal });
    await expect(session.compareAndSwap('k', null, new Uint8Array([1]), signal)).rejects.toMatchObject({
      code: 'outcome-unknown',
    });
    await session.dispose();
  });
});

test('fragmented UTF-8 payloads round trip through the native session', async () => {
  await withFakeNative('ok', async (executable) => {
    const signal = new AbortController().signal;
    const session = await connectNative({ executable, containerId: 'test', signal });
    await expect(session.compareAndSwap('k', null, new Uint8Array([1, 2]), signal)).resolves.toMatchObject({
      kind: 'written',
    });
    await expect(session.read('k', signal)).resolves.toMatchObject({ kind: 'present', value: new Uint8Array([1, 2]) });
    await session.dispose();
  });
});

test('oversized native output is rejected and pending work settles', async () => {
  await withFakeNative('oversized', async (executable) => {
    const session = await connectNative({ executable, containerId: 'test', signal: new AbortController().signal });
    await expect(session.read('k', new AbortController().signal)).rejects.toThrow();
    await session.dispose();
  });
});

test('identity changes fence the session generation', async () => {
  await withFakeNative('identity-change', async (executable) => {
    const session = await connectNative({ executable, containerId: 'test', signal: new AbortController().signal });
    await expect(session.read('k', new AbortController().signal)).rejects.toMatchObject({ code: 'identity-changed' });
    await session.dispose();
  });
});

test('disposal is idempotent', async () => {
  await withFakeNative('ok', async (executable) => {
    const session = await connectNative({ executable, containerId: 'test', signal: new AbortController().signal });
    await Promise.all([session.dispose(), session.dispose()]);
  });
});

test('abort cancels a read without claiming a mutation outcome', async () => {
  await withFakeNative('hold', async (executable) => {
    const session = await connectNative({ executable, containerId: 'test', signal: new AbortController().signal });
    const controller = new AbortController();
    const pending = session.read('k', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    await session.dispose();
  });
});

test('partial native frames fail the session as invalid data', async () => {
  await withFakeNative('partial-frame', async (executable) => {
    const session = await connectNative({ executable, containerId: 'test', signal: new AbortController().signal });
    await expect(session.read('k', new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-data' });
    await session.dispose();
  });
});

test('duplicate and unexpected replies fail pending work', async () => {
  for (const mode of ['duplicate', 'unexpected'] as const) {
    await withFakeNative(mode, async (executable) => {
      const session = await connectNative({ executable, containerId: 'test', signal: new AbortController().signal });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(session.read('k', new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-data' });
      await session.dispose();
    });
  }
});

test('malformed native output during CAS preserves outcome unknown', async () => {
  await withFakeNative('malformed', async (executable) => {
    const session = await connectNative({ executable, containerId: 'test', signal: new AbortController().signal });
    await expect(
      session.compareAndSwap('k', null, new Uint8Array([1]), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'outcome-unknown' });
    await expect(session.read('k', new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-data' });
    await session.dispose();
  });
});
