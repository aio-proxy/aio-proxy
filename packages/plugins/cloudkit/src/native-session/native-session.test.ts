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
