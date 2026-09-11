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

// The spawned helper's exit and its stdout EOF are two channels for one event, and CI reaps the
// process before the pipe drains. Whichever the session believed first used to decide the error
// code, so a helper dying mid-frame reported a retryable offline instead of fencing the protocol.
test('a helper that dies mid-frame reports invalid data even when its exit is observed first', async () => {
  let push!: (chunk: string) => void;
  let closeStdout!: () => void;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
      closeStdout = () => controller.close();
    },
  });
  let markExited!: () => void;
  const exited = new Promise<number>((resolve) => {
    markExited = () => resolve(0);
  });
  const session = await connectNative({
    executable: 'unused',
    containerId: 'test',
    signal: new AbortController().signal,
    spawn: () => ({
      stdin: {
        write(data: string) {
          const request = JSON.parse(data) as { id: string; op: string };
          if (request.op === 'connect')
            push(
              `${JSON.stringify({
                id: request.id,
                ok: true,
                result: { identityId: 'fake', spaceId: 'default', maxValueBytes: 1024, protocol: 1, version: 'fake' },
              })}\n`,
            );
          if (request.op === 'read') {
            push('{"id":"partial"');
            markExited();
            setTimeout(closeStdout, 5);
          }
          return data.length;
        },
      },
      stdout,
      stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      exited,
      kill: () => {},
    }),
  });
  await expect(session.read('k', new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-data' });
});
