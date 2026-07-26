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
  test('keeps a bounded error listener count across many gzip write flushes', async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => {
      warnings.push(warning);
    };
    process.on('warning', onWarning);

    const plaintext = new TextEncoder().encode('x'.repeat(64));
    const encoded = new Uint8Array(gzipSync(Buffer.from(plaintext)));
    const reader = createContentDecodedReader(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
      'gzip',
    );

    for (;;) {
      const result = await reader.read();
      if (result.done) break;
    }

    process.off('warning', onWarning);
    expect(warnings.some((warning) => warning.name === 'MaxListenersExceededWarning')).toBe(false);
    const stage = trackedStages.at(-1);
    expect(stage).toBeDefined();
    expect(stage!.listenerCount('error')).toBeLessThanOrEqual(2);
  });

  test('surfaces a decoder error that arrives between operations on the next read', async () => {
    trackedStages.length = 0;
    const reader = createContentDecodedReader(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(DELAYED_ERROR_MARKER);
          controller.enqueue(Uint8Array.of(0x01));
          controller.close();
        },
      }),
      'gzip',
    );

    const first = await reader.read();
    expect(first.error).toBeUndefined();
    expect(Buffer.concat(first.chunks.map((chunk) => Buffer.from(chunk))).toString()).toBe('ok-before-delayed-error');

    await Bun.sleep(20);
    const second = await reader.read();
    expect(second.error).toBe(DELAYED_ERROR);
  });

  test('wakes an in-flight source read when a decoder error arrives between operations', async () => {
    trackedStages.length = 0;
    let pulls = 0;
    let markSecondPullStarted = () => undefined;
    const secondPullStarted = new Promise<void>((resolve) => {
      markSecondPullStarted = resolve;
    });
    const reader = createContentDecodedReader(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(DELAYED_ERROR_MARKER);
              return;
            }
            markSecondPullStarted();
            return new Promise(() => undefined);
          },
        },
        { highWaterMark: 0 },
      ),
      'gzip',
    );

    const first = await reader.read();
    expect(first.error).toBeUndefined();
    const secondRead = reader.read();
    await secondPullStarted;
    const second = await Promise.race([secondRead, Bun.sleep(100).then(() => undefined)]);

    expect(pulls).toBe(2);
    expect(second?.error).toBe(DELAYED_ERROR);
  });
});
