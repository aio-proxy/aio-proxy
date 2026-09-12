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

test('identity changes fence the session generation and outlast the self-disposal', async () => {
  await withFakeNative('identity-change', async (executable) => {
    const session = await connectNative({ executable, containerId: 'test', signal: new AbortController().signal });
    await expect(session.read('k', new AbortController().signal)).rejects.toMatchObject({ code: 'identity-changed' });
    await session.dispose();
    // The identity can also change with nothing in flight, and then the self-disposal is all that
    // is left of it. A later poll still has to say why: `cancelled` is the code the sync engine
    // deliberately ignores, so reporting it here leaves synchronization silently dead.
    await expect(session.read('k', new AbortController().signal)).rejects.toMatchObject({ code: 'identity-changed' });
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

// The helper answers the original id from its own request task, so cancelling races the reply it
// pre-empts. Classifying that expected late reply as corruption used to fence the session and make
// every later CloudKit call fail.
test('a late reply for a locally cancelled request does not fence the session', async () => {
  await withFakeNative('late-cancel-reply', async (executable) => {
    const session = await connectNative({ executable, containerId: 'test', signal: new AbortController().signal });
    const controller = new AbortController();
    const cancelled = session.read('k', controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ code: 'cancelled' });
    await expect(session.read('k', new AbortController().signal)).resolves.toMatchObject({ kind: 'absent' });
    await session.dispose();
  });
});

// Callers share one long-lived lifecycle signal across a whole reconciliation, so a listener left
// behind per settled request grows without bound and floods the helper with stale cancels on close.
test('settled requests detach their abort listeners from the caller signal', async () => {
  await withFakeNative('ok', async (executable) => {
    const session = await connectNative({ executable, containerId: 'test', signal: new AbortController().signal });
    const signal = new AbortController().signal;
    let live = 0;
    const { addEventListener, removeEventListener } = signal;
    Object.assign(signal, {
      addEventListener(...args: Parameters<AbortSignal['addEventListener']>) {
        live += 1;
        return addEventListener.apply(signal, args);
      },
      removeEventListener(...args: Parameters<AbortSignal['removeEventListener']>) {
        live -= 1;
        return removeEventListener.apply(signal, args);
      },
    });
    await session.compareAndSwap('k', null, new Uint8Array([1]), signal);
    await session.read('k', signal);
    await session.list({ prefix: '' }, signal);
    expect(live).toBe(0);
    await session.dispose();
  });
});

// Exit and stdout EOF are two channels for one event, and the parent can observe the dead
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

// The helper acknowledges dispose with that request's own id. Treating the expected reply as
// corruption used to fail an in-flight CAS as invalid-data, skipping the outcome-unknown reread
// that reconciles a mutation which may already have committed remotely.
test('an in-flight mutation survives disposal as outcome unknown, not protocol corruption', async () => {
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
          // The CAS is never answered: it is still in flight when dispose is acknowledged.
          if (request.op === 'dispose') {
            push(`${JSON.stringify({ id: request.id, ok: true, result: null })}\n`);
            setTimeout(() => {
              closeStdout();
              markExited();
            }, 5);
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
  const mutation = session
    .compareAndSwap('k', null, new Uint8Array([1]), new AbortController().signal)
    .catch((error: unknown) => error);
  await session.dispose();
  expect(await mutation).toMatchObject({ code: 'outcome-unknown' });
});
// callers switch on the session's own error codes, and a raw Error carries none of them.
test('a write to a dead helper is classified by the stdout it left behind, not by EPIPE', async () => {
  let push!: (chunk: string) => void;
  let closeStdout!: () => void;
  const stdout = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
      closeStdout = () => controller.close();
    },
  });
  const session = await connectNative({
    executable: 'unused',
    containerId: 'test',
    signal: new AbortController().signal,
    spawn: () => ({
      stdin: {
        write(data: string) {
          const request = JSON.parse(data) as { id: string; op: string };
          if (request.op === 'connect') {
            push(
              `${JSON.stringify({
                id: request.id,
                ok: true,
                result: { identityId: 'fake', spaceId: 'default', maxValueBytes: 1024, protocol: 1, version: 'fake' },
              })}\n`,
            );
            // The helper truncates a frame and dies, so every later write hits a closed pipe.
            push('{"id":"partial"');
            setTimeout(closeStdout, 5);
            return data.length;
          }
          throw new Error('EPIPE: broken pipe, write');
        },
      },
      stdout,
      stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      exited: new Promise<number>((resolve) => setTimeout(() => resolve(0), 5)),
      kill: () => {},
    }),
  });
  await expect(session.read('k', new AbortController().signal)).rejects.toMatchObject({ code: 'invalid-data' });
});
