import { afterAll, describe, expect, mock, test } from 'bun:test';
import { Transform } from 'node:stream';
import type * as Zlib from 'node:zlib';
import { gzipSync } from 'node:zlib';

import {
  actualCreateBrotliDecompress,
  actualCreateGunzip,
  actualZlib,
  DELAYED_ERROR,
  DELAYED_ERROR_MARKER,
  destroyCounts,
  trackedStages,
  trackStage,
} from './content-decoding-review.test-support';

mock.module('node:zlib', () => {
  const createGunzip = (options?: Zlib.ZlibOptions) => {
    const real = actualCreateGunzip(options);
    let sawDelayed = false;
    let ending = false;
    const wrapper = new Transform({
      transform(chunk, encoding, callback) {
        const bytes = Buffer.from(chunk as Uint8Array);
        if (bytes.equals(Buffer.from(DELAYED_ERROR_MARKER))) {
          sawDelayed = true;
          this.push(Buffer.from('ok-before-delayed-error'));
          callback();
          // Emit after the current write/flush operation has fully settled.
          setTimeout(() => {
            if (!wrapper.destroyed) wrapper.emit('error', DELAYED_ERROR);
          }, 5);
          return;
        }
        real.write(chunk, encoding as BufferEncoding, callback);
      },
      flush(callback) {
        if (sawDelayed || real.destroyed || real.closed) {
          callback();
          return;
        }
        ending = true;
        real.once('close', () => {
          callback();
        });
        if (!real.writableEnded) real.end();
      },
    });
    real.on('data', (data: Buffer) => {
      if (!wrapper.destroyed) wrapper.push(data);
    });
    real.on('error', (error: Error) => {
      if (!wrapper.destroyed) wrapper.destroy(error);
    });
    real.on('close', () => {
      if (!wrapper.destroyed && !wrapper.readableEnded && !ending) wrapper.push(null);
    });
    wrapper.flush = ((kind?: unknown, cb?: (error?: Error | null) => void) => {
      const callback = typeof kind === 'function' ? (kind as (error?: Error | null) => void) : cb;
      if (sawDelayed || real.destroyed || real.writableEnded) {
        callback?.(null);
        return wrapper;
      }
      if (typeof kind === 'number') real.flush(kind, callback ?? (() => undefined));
      else real.flush(callback ?? (() => undefined));
      return wrapper;
    }) as typeof real.flush;
    const originalDestroy = wrapper.destroy.bind(wrapper);
    wrapper.destroy = ((error?: Error) => {
      if (!real.destroyed) real.destroy(error);
      return originalDestroy(error);
    }) as typeof wrapper.destroy;
    return trackStage(wrapper) as unknown as ReturnType<typeof actualCreateGunzip>;
  };
  const createBrotliDecompress = (...args: Parameters<typeof actualCreateBrotliDecompress>) =>
    trackStage(actualCreateBrotliDecompress(...args));
  return { ...actualZlib, createBrotliDecompress, createGunzip };
});

afterAll(() => {
  mock.restore();
});

const { createContentDecodedReader } = await import('./content-decoding');

describe('createContentDecodedReader review regressions', () => {
  test('destroys every decoder stage even when source cancel rejects', async () => {
    trackedStages.length = 0;
    const encoded = new Uint8Array(gzipSync(Buffer.from('cancel-reject')));
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
      },
      cancel() {
        return Promise.reject(new Error('cancel rejected'));
      },
    });

    const reader = createContentDecodedReader(source, 'gzip');
    await reader.read();
    await reader.cancel(new Error('caller cancel'));

    const stage = trackedStages.at(-1);
    expect(stage).toBeDefined();
    expect(stage!.destroyed).toBe(true);
  });

  test('destroys every decoder stage before a hung source cancel settles', async () => {
    trackedStages.length = 0;
    const encoded = new Uint8Array(gzipSync(Buffer.from('cancel-hangs')));
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
      },
      cancel() {
        return new Promise(() => undefined);
      },
    });

    const reader = createContentDecodedReader(source, 'gzip');
    await reader.read();
    void reader.cancel(new Error('caller cancel'));
    await Bun.sleep(10);

    const stage = trackedStages.at(-1);
    expect(stage).toBeDefined();
    expect(stage!.destroyed).toBe(true);
  });

  test('destroys every stacked decoder exactly once across repeated cancellation', async () => {
    trackedStages.length = 0;
    const source = new ReadableStream<Uint8Array>({});
    const reader = createContentDecodedReader(source, 'gzip, br');

    await reader.cancel(new Error('caller cancel'));
    await reader.cancel(new Error('repeated cancel'));

    expect(trackedStages).toHaveLength(2);
    expect(trackedStages.every((stage) => stage.destroyed)).toBe(true);
    expect(trackedStages.map((stage) => destroyCounts.get(stage))).toEqual([1, 1]);
  });

  test('cancels and destroys after a rejected source read', async () => {
    trackedStages.length = 0;
    const source = new ReadableStream<Uint8Array>({
      pull() {
        return Promise.reject(new Error('source read rejected'));
      },
      cancel() {
        // Bun rethrows the pull rejection from reader.cancel and skips this callback.
        // Cleanup must still destroy decoder stages unconditionally.
      },
    });

    const reader = createContentDecodedReader(source, 'gzip');
    const result = await reader.read();
    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error)).toMatch(/source read rejected/);
    const stage = trackedStages.at(-1);
    expect(stage).toBeDefined();
    expect(stage!.destroyed).toBe(true);
    // Idempotent cleanup after the rejection path.
    await reader.cancel(new Error('second cancel'));
    expect(stage!.destroyed).toBe(true);
  });
});
