import type * as Zlib from "node:zlib";

import { afterAll, describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { Transform } from "node:stream";
import { gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const actualZlib = require("node:zlib") as typeof Zlib;
const actualCreateGunzip = actualZlib.createGunzip.bind(actualZlib);
const actualCreateBrotliDecompress = actualZlib.createBrotliDecompress.bind(
  actualZlib,
) as typeof actualZlib.createBrotliDecompress;

const DELAYED_ERROR_MARKER = Uint8Array.of(0x5b, 0xae, 0x03, 0x04);
const DELAYED_ERROR = new Error("between-operations decoder failure");
const trackedStages: Transform[] = [];
const destroyCounts = new WeakMap<Transform, number>();

function trackStage<T extends Transform>(stage: T): T {
  const originalDestroy = stage.destroy.bind(stage);
  stage.destroy = ((error?: Error) => {
    destroyCounts.set(stage, (destroyCounts.get(stage) ?? 0) + 1);
    return originalDestroy(error);
  }) as typeof stage.destroy;
  trackedStages.push(stage);
  return stage;
}

mock.module("node:zlib", () => {
  const createGunzip = (options?: Zlib.ZlibOptions) => {
    const real = actualCreateGunzip(options);
    let sawDelayed = false;
    let ending = false;
    const wrapper = new Transform({
      transform(chunk, encoding, callback) {
        const bytes = Buffer.from(chunk as Uint8Array);
        if (bytes.equals(Buffer.from(DELAYED_ERROR_MARKER))) {
          sawDelayed = true;
          this.push(Buffer.from("ok-before-delayed-error"));
          callback();
          // Emit after the current write/flush operation has fully settled.
          setTimeout(() => {
            if (!wrapper.destroyed) wrapper.emit("error", DELAYED_ERROR);
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
        real.once("close", () => {
          callback();
        });
        if (!real.writableEnded) real.end();
      },
    });
    real.on("data", (data: Buffer) => {
      if (!wrapper.destroyed) wrapper.push(data);
    });
    real.on("error", (error: Error) => {
      if (!wrapper.destroyed) wrapper.destroy(error);
    });
    real.on("close", () => {
      if (!wrapper.destroyed && !wrapper.readableEnded && !ending) wrapper.push(null);
    });
    wrapper.flush = ((kind?: unknown, cb?: (error?: Error | null) => void) => {
      const callback = typeof kind === "function" ? (kind as (error?: Error | null) => void) : cb;
      if (sawDelayed || real.destroyed || real.writableEnded) {
        callback?.(null);
        return wrapper;
      }
      if (typeof kind === "number") real.flush(kind, callback ?? (() => undefined));
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

const { createContentDecodedReader } = await import("./content-decoding");

describe("createContentDecodedReader review regressions", () => {
  test("keeps a bounded error listener count across many gzip write flushes", async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => {
      warnings.push(warning);
    };
    process.on("warning", onWarning);

    const plaintext = new TextEncoder().encode("x".repeat(64));
    const encoded = new Uint8Array(gzipSync(Buffer.from(plaintext)));
    const reader = createContentDecodedReader(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
      "gzip",
    );

    for (;;) {
      const result = await reader.read();
      if (result.done) break;
    }

    process.off("warning", onWarning);
    expect(warnings.some((warning) => warning.name === "MaxListenersExceededWarning")).toBe(false);
    const stage = trackedStages.at(-1);
    expect(stage).toBeDefined();
    expect(stage!.listenerCount("error")).toBeLessThanOrEqual(2);
  });

  test("surfaces a decoder error that arrives between operations on the next read", async () => {
    trackedStages.length = 0;
    const reader = createContentDecodedReader(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(DELAYED_ERROR_MARKER);
          controller.enqueue(Uint8Array.of(0x01));
          controller.close();
        },
      }),
      "gzip",
    );

    const first = await reader.read();
    expect(first.error).toBeUndefined();
    expect(Buffer.concat(first.chunks.map((chunk) => Buffer.from(chunk))).toString()).toBe("ok-before-delayed-error");

    await Bun.sleep(20);
    const second = await reader.read();
    expect(second.error).toBe(DELAYED_ERROR);
  });

  test("wakes an in-flight source read when a decoder error arrives between operations", async () => {
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
      "gzip",
    );

    const first = await reader.read();
    expect(first.error).toBeUndefined();
    const secondRead = reader.read();
    await secondPullStarted;
    const second = await Promise.race([secondRead, Bun.sleep(100).then(() => undefined)]);

    expect(pulls).toBe(2);
    expect(second?.error).toBe(DELAYED_ERROR);
  });

  test("destroys every decoder stage even when source cancel rejects", async () => {
    trackedStages.length = 0;
    const encoded = new Uint8Array(gzipSync(Buffer.from("cancel-reject")));
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
      },
      cancel() {
        return Promise.reject(new Error("cancel rejected"));
      },
    });

    const reader = createContentDecodedReader(source, "gzip");
    await reader.read();
    await reader.cancel(new Error("caller cancel"));

    const stage = trackedStages.at(-1);
    expect(stage).toBeDefined();
    expect(stage!.destroyed).toBe(true);
  });

  test("destroys every decoder stage before a hung source cancel settles", async () => {
    trackedStages.length = 0;
    const encoded = new Uint8Array(gzipSync(Buffer.from("cancel-hangs")));
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
      },
      cancel() {
        return new Promise(() => undefined);
      },
    });

    const reader = createContentDecodedReader(source, "gzip");
    await reader.read();
    void reader.cancel(new Error("caller cancel"));
    await Bun.sleep(10);

    const stage = trackedStages.at(-1);
    expect(stage).toBeDefined();
    expect(stage!.destroyed).toBe(true);
  });

  test("destroys every stacked decoder exactly once across repeated cancellation", async () => {
    trackedStages.length = 0;
    const source = new ReadableStream<Uint8Array>({});
    const reader = createContentDecodedReader(source, "gzip, br");

    await reader.cancel(new Error("caller cancel"));
    await reader.cancel(new Error("repeated cancel"));

    expect(trackedStages).toHaveLength(2);
    expect(trackedStages.every((stage) => stage.destroyed)).toBe(true);
    expect(trackedStages.map((stage) => destroyCounts.get(stage))).toEqual([1, 1]);
  });

  test("cancels and destroys after a rejected source read", async () => {
    trackedStages.length = 0;
    const source = new ReadableStream<Uint8Array>({
      pull() {
        return Promise.reject(new Error("source read rejected"));
      },
      cancel() {
        // Bun rethrows the pull rejection from reader.cancel and skips this callback.
        // Cleanup must still destroy decoder stages unconditionally.
      },
    });

    const reader = createContentDecodedReader(source, "gzip");
    const result = await reader.read();
    expect(result.error).toBeInstanceOf(Error);
    expect(String(result.error)).toMatch(/source read rejected/);
    const stage = trackedStages.at(-1);
    expect(stage).toBeDefined();
    expect(stage!.destroyed).toBe(true);
    // Idempotent cleanup after the rejection path.
    await reader.cancel(new Error("second cancel"));
    expect(stage!.destroyed).toBe(true);
  });
});
