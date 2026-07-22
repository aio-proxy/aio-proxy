import type * as Zlib from "node:zlib";

import { afterAll, describe, expect, mock, test } from "bun:test";
import { createRequire } from "node:module";
import { Transform } from "node:stream";

const require = createRequire(import.meta.url);
const actualZlib = require("node:zlib") as typeof Zlib;
const actualCreateGunzip = actualZlib.createGunzip.bind(actualZlib);

/** Sentinel body for the same-batch error test; not valid gzip. */
const SAME_BATCH_MARKER = Uint8Array.of(0x5b, 0xad, 0x01, 0x02);
const SAME_BATCH_DECODED = new TextEncoder().encode("decoded-before-error");
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
          this.push(Buffer.from(SAME_BATCH_DECODED));
          callback(SAME_BATCH_ERROR);
          return;
        }
        real.write(chunk, encoding as BufferEncoding, callback);
      },
      flush(callback) {
        if (sawMarker) {
          callback();
          return;
        }
        if (real.destroyed || real.closed) {
          callback();
          return;
        }
        ending = true;
        // Wait for real close so error-before-close ordering matches node:zlib.
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
      if (!wrapper.destroyed && !wrapper.readableEnded && !ending) {
        wrapper.push(null);
      }
    });
    wrapper.flush = ((kind?: unknown, cb?: (error?: Error | null) => void) => {
      const callback = typeof kind === "function" ? (kind as (error?: Error | null) => void) : cb;
      if (sawMarker || real.destroyed || real.writableEnded) {
        callback?.(null);
        return wrapper;
      }
      if (typeof kind === "number") {
        real.flush(kind, callback ?? (() => undefined));
      } else {
        real.flush(callback ?? (() => undefined));
      }
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

const { createContentDecodedReader } = await import("./content-decoding");

const compressionFormats = {
  gzip: "gzip",
  deflate: "deflate",
  br: "brotli",
  zstd: "zstd",
} as const satisfies Record<string, Bun.CompressionFormat>;

// lib.dom's constructor type omits Bun's runtime-supported brotli/zstd values.
const BunCompressionStream = CompressionStream as unknown as {
  new (format: Bun.CompressionFormat): CompressionStream;
};

async function compress(encoding: keyof typeof compressionFormats, payload: Uint8Array): Promise<Uint8Array> {
  const stream = new BunCompressionStream(compressionFormats[encoding]);
  const writer = stream.writable.getWriter();
  await writer.write(payload);
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

async function compressStacked(
  encodings: readonly (keyof typeof compressionFormats)[],
  payload: Uint8Array,
): Promise<Uint8Array> {
  let current = payload;
  for (const encoding of encodings) {
    current = await compress(encoding, current);
  }
  return current;
}

function bytesSource(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]!);
      index += 1;
    },
  });
}

async function readAll(
  reader: ReturnType<typeof createContentDecodedReader>,
): Promise<{ text: string; error?: unknown }> {
  const parts: Uint8Array[] = [];
  let error: unknown;
  for (;;) {
    const result = await reader.read();
    for (const chunk of result.chunks) parts.push(chunk);
    if (result.error !== undefined && error === undefined) error = result.error;
    if (result.done || result.error !== undefined) break;
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return { text: new TextDecoder().decode(merged), error };
}

describe("createContentDecodedReader codecs", () => {
  test("decodes gzip, deflate, br, and zstd incrementally", async () => {
    const plaintext = new TextEncoder().encode("incremental codec payload");
    for (const encoding of Object.keys(compressionFormats) as (keyof typeof compressionFormats)[]) {
      const encoded = await compress(encoding, plaintext);
      const mid = Math.max(1, Math.floor(encoded.byteLength / 2));
      const reader = createContentDecodedReader(
        bytesSource([encoded.subarray(0, mid), encoded.subarray(mid)]),
        encoding,
      );
      const { text, error } = await readAll(reader);
      expect(error).toBeUndefined();
      expect(text).toBe("incremental codec payload");
    }
  });

  test("passes absent and identity encodings through unchanged", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    for (const header of [null, "identity", " identity ", "identity, identity"]) {
      const reader = createContentDecodedReader(bytesSource([payload]), header);
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.error).toBeUndefined();
      expect(first.chunks).toEqual([payload]);
      const end = await reader.read();
      expect(end).toEqual({ chunks: [], done: true });
    }
  });

  test("decodes stacked Content-Encoding values in reverse order", async () => {
    const plaintext = new TextEncoder().encode("stacked encodings");
    // Content-Encoding lists application order; decoding reverses it.
    const encoded = await compressStacked(["gzip", "deflate"], plaintext);
    const reader = createContentDecodedReader(bytesSource([encoded]), "gzip, deflate");
    const { text, error } = await readAll(reader);
    expect(error).toBeUndefined();
    expect(text).toBe("stacked encodings");
  });

  test("rejects an unsupported Content-Encoding before reading the source", async () => {
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    expect(() => createContentDecodedReader(source, "lzma")).toThrow(/lzma|unsupported|encoding/i);
    expect(pulls).toBe(0);
  });

  test("returns decoded chunks before a decoder error from the same encoded batch", async () => {
    const reader = createContentDecodedReader(bytesSource([SAME_BATCH_MARKER]), "gzip");
    const result = await reader.read();
    expect(result.done).toBe(false);
    expect(result.chunks.length).toBeGreaterThan(0);
    expect(Buffer.concat(result.chunks.map((chunk) => Buffer.from(chunk))).toString()).toBe("decoded-before-error");
    expect(result.error).toBe(SAME_BATCH_ERROR);
  });
});
