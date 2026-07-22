import type * as Zlib from "node:zlib";

import { afterAll, describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { Transform } from "node:stream";

const require = createRequire(import.meta.url);
const actualZlib = require("node:zlib") as typeof Zlib;
const actualCreateGunzip = actualZlib.createGunzip.bind(actualZlib);

const SAME_BATCH_MARKER = Uint8Array.of(0x5b, 0xad, 0x01, 0x02);
const SAME_BATCH_TERMINAL = new TextEncoder().encode(
  'event: response.completed\ndata: {"type":"response.completed"}\n\n',
);
const SAME_BATCH_ERROR = new Error("same-batch decoder failure");

mock.module("node:zlib", () => {
  const createGunzip = (options?: Zlib.ZlibOptions) => {
    const real = actualCreateGunzip(options);
    let sawMarker = false;
    let ending = false;
    const wrapper = new Transform({
      transform(chunk, encoding, callback) {
        const bytes = Buffer.from(chunk as Uint8Array);
        if (bytes.equals(Buffer.from(SAME_BATCH_MARKER))) {
          sawMarker = true;
          this.push(Buffer.from(SAME_BATCH_TERMINAL));
          callback(SAME_BATCH_ERROR);
          return;
        }
        real.write(chunk, encoding as BufferEncoding, callback);
      },
      flush(callback) {
        if (sawMarker || real.destroyed || real.closed) {
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
      if (sawMarker || real.destroyed || real.writableEnded) {
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
    return wrapper as unknown as ReturnType<typeof actualCreateGunzip>;
  };
  return { ...actualZlib, createGunzip };
});

afterAll(() => {
  mock.restore();
});

const { createOpenAIStreamFetch } = await import("./openai-stream-fetch");

describe("createOpenAIStreamFetch same-batch terminal", () => {
  test("lets a terminal frame win over a decoder error returned with the same batch", async () => {
    const fetch = createOpenAIStreamFetch("openai-response", async () => {
      return new Response(SAME_BATCH_MARKER, {
        headers: {
          "content-type": "text/event-stream",
          "content-encoding": "gzip",
        },
      });
    });
    const response = await fetch("https://example.test/stream");
    expect(await response.text()).toBe(new TextDecoder().decode(SAME_BATCH_TERMINAL));
  });
});
