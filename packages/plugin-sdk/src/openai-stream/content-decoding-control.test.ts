import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";

import { createContentDecodedReader } from "./content-decoding";

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

async function compressGzip(payload: Uint8Array): Promise<Uint8Array> {
  const stream = new BunCompressionStream(compressionFormats.gzip);
  const writer = stream.writable.getWriter();
  await writer.write(payload);
  await writer.close();
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

describe("createContentDecodedReader control", () => {
  test("does not request the next encoded chunk until read is called again", async () => {
    let pulls = 0;
    const plaintext = new TextEncoder().encode("chunk-one");
    const encoded = await compressGzip(plaintext);
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(encoded);
            return;
          }
          controller.enqueue(encoded);
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );

    const decoded = createContentDecodedReader(source, "gzip");
    expect(pulls).toBe(0);

    const first = await decoded.read();
    expect(pulls).toBe(1);
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(Buffer.concat(first.chunks.map((c) => Buffer.from(c))))).toBe("chunk-one");

    await Bun.sleep(10);
    expect(pulls).toBe(1);

    const second = await decoded.read();
    expect(pulls).toBe(2);
    expect(second.done).toBe(false);
  });

  test("finalizes every decoder stage at encoded EOF", async () => {
    const plaintext = new TextEncoder().encode("finalize-me");
    const full = await compressGzip(plaintext);
    // Split before the final bytes so EOF finalization (stage end) is required for a clean close.
    const split = Math.max(1, full.byteLength - 8);
    const reader = createContentDecodedReader(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(full.subarray(0, split));
          controller.enqueue(full.subarray(split));
          controller.close();
        },
      }),
      "gzip",
    );

    const first = await reader.read();
    expect(first.done).toBe(false);
    const second = await reader.read();
    expect(second.done).toBe(false);
    const end = await reader.read();
    expect(end.done).toBe(true);
    const text = new TextDecoder().decode(
      Buffer.concat([...first.chunks, ...second.chunks, ...end.chunks].map((chunk) => Buffer.from(chunk))),
    );
    expect(text).toBe("finalize-me");
    expect(end.error).toBeUndefined();
  });

  test("returns final decoded chunks alongside a finalization error", async () => {
    const plaintext = new TextEncoder().encode("VISIBLE");
    const full = gzipSync(Buffer.from(plaintext));
    const truncated = full.subarray(0, full.byteLength - 1);
    const reader = createContentDecodedReader(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(truncated));
          controller.close();
        },
      }),
      "gzip",
    );

    const first = await reader.read();
    expect(first.done).toBe(false);
    const end = await reader.read();
    expect(end.done).toBe(true);
    const text = new TextDecoder().decode(
      Buffer.concat([...first.chunks, ...end.chunks].map((chunk) => Buffer.from(chunk))),
    );
    expect(text).toBe("VISIBLE");
    expect(end.error).toBeDefined();
  });

  test("cancels the encoded reader exactly once and preserves the first reason", async () => {
    const plaintext = new TextEncoder().encode("cancel-me");
    const encoded = await compressGzip(plaintext);
    let cancelCount = 0;
    let cancelReason: unknown;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
      },
      cancel(reason) {
        cancelCount += 1;
        cancelReason = reason;
      },
    });

    const reader = createContentDecodedReader(source, null);
    const reason = new Error("caller cancel");
    await reader.cancel(reason);
    await reader.cancel(new Error("second cancel"));
    expect(cancelCount).toBe(1);
    expect(cancelReason).toBe(reason);
  });
});
