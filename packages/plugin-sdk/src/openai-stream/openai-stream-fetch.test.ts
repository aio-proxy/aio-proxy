import { describe, expect, test } from "bun:test";

import { createOpenAIStreamFetch } from "./openai-stream-fetch";

const encoder = new TextEncoder();
const compressionFormats = {
  gzip: "gzip",
  deflate: "deflate",
  br: "brotli",
  zstd: "zstd",
} as const satisfies Record<string, Bun.CompressionFormat>;

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

const responsesTerminal = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';

describe("createOpenAIStreamFetch", () => {
  test("advertises gzip, deflate, br, zstd and disables Bun decompression", async () => {
    let seenHeaders: Headers | undefined;
    let seenDecompress: unknown;
    const fetch = createOpenAIStreamFetch("openai-response", async (_input, init) => {
      seenHeaders = new Headers(init?.headers);
      seenDecompress = (init as { decompress?: boolean } | undefined)?.decompress;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    });
    await fetch("https://example.test/v1");
    expect(seenHeaders?.get("accept-encoding")).toBe("gzip, deflate, br, zstd");
    expect(seenDecompress).toBe(false);
  });

  test("preserves method, body, signal, redirect, and caller headers other than Accept-Encoding", async () => {
    const signal = AbortSignal.timeout(5_000);
    let seen: Request | undefined;
    let seenInit: RequestInit | undefined;
    const fetch = createOpenAIStreamFetch("openai-compatible", async (input, init) => {
      seen = input instanceof Request ? input : new Request(input, init);
      seenInit = init;
      return new Response("ok");
    });
    await fetch("https://example.test/chat", {
      method: "POST",
      body: JSON.stringify({ ping: true }),
      signal,
      redirect: "manual",
      headers: {
        authorization: "Bearer test",
        "x-custom": "keep-me",
        "accept-encoding": "identity",
      },
    });
    expect(seen?.method).toBe("POST");
    expect(await seen?.text()).toBe(JSON.stringify({ ping: true }));
    expect(seen?.signal).toBe(signal);
    expect(seenInit?.redirect ?? seen?.redirect).toBe("manual");
    const headers = new Headers(seenInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer test");
    expect(headers.get("x-custom")).toBe("keep-me");
    expect(headers.get("accept-encoding")).toBe("gzip, deflate, br, zstd");
  });

  test("closes after a compressed terminal without requesting the next encoded chunk", async () => {
    for (const encoding of Object.keys(compressionFormats) as (keyof typeof compressionFormats)[]) {
      let pulls = 0;
      const encodedTerminal = await compress(encoding, encoder.encode(responsesTerminal));
      const body = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            pulls += 1;
            if (pulls === 1) {
              controller.enqueue(encodedTerminal);
              return;
            }
            controller.enqueue(Uint8Array.of(0xff));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
      const fetch = createOpenAIStreamFetch("openai-response", async () => {
        return new Response(body, {
          headers: {
            "content-type": "text/event-stream",
            "content-encoding": encoding,
          },
        });
      });
      const response = await fetch("https://example.test/stream");
      expect(await response.text()).toBe(responsesTerminal);
      await Bun.sleep(10);
      expect(pulls).toBe(1);
    }
  });

  test("propagates raw-source and decoder errors before terminal", async () => {
    const sourceError = new TypeError("raw source failed");
    const failingSource = new ReadableStream<Uint8Array>({
      pull() {
        throw sourceError;
      },
    });
    const sourceFetch = createOpenAIStreamFetch("openai-response", async () => {
      return new Response(failingSource, { headers: { "content-type": "text/event-stream" } });
    });
    await expect(sourceFetch("https://example.test/stream").then((r) => r.text())).rejects.toBe(sourceError);

    const truncated = (await compress("gzip", encoder.encode("data: hi\n\n"))).subarray(0, 8);
    const decoderFetch = createOpenAIStreamFetch("openai-compatible", async () => {
      return new Response(truncated, {
        headers: {
          "content-type": "text/event-stream",
          "content-encoding": "gzip",
        },
      });
    });
    await expect(decoderFetch("https://example.test/stream").then((r) => r.text())).rejects.toBeDefined();
  });

  test("propagates downstream cancellation to the encoded reader and every decoder once", async () => {
    let cancelCount = 0;
    let cancelReason: unknown;
    const encoded = await compress("gzip", encoder.encode("data: slow\n\n"));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
      },
      cancel(reason) {
        cancelCount += 1;
        cancelReason = reason;
      },
    });
    const fetch = createOpenAIStreamFetch("openai-compatible", async () => {
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          "content-encoding": "gzip",
        },
      });
    });
    const response = await fetch("https://example.test/stream");
    await response.body?.cancel("client-gone");
    expect(cancelCount).toBe(1);
    expect(cancelReason).toBe("client-gone");
  });

  test("decodes compressed non-SSE JSON and never suppresses its errors", async () => {
    const json = JSON.stringify({ ok: true, value: 42 });
    const encoded = await compress("gzip", encoder.encode(json));
    const okFetch = createOpenAIStreamFetch("openai-response", async () => {
      return new Response(encoded, {
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
      });
    });
    expect(await (await okFetch("https://example.test/json")).text()).toBe(json);

    const bad = encoded.subarray(0, 6);
    const errFetch = createOpenAIStreamFetch("openai-response", async () => {
      return new Response(bad, {
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
        },
      });
    });
    await expect(errFetch("https://example.test/json").then((r) => r.text())).rejects.toBeDefined();
  });

  test("preserves a bodyless upstream response", async () => {
    const fetch = createOpenAIStreamFetch(
      "openai-response",
      async () => new Response(null, { status: 204, headers: { "x-request-id": "req-empty" } }),
    );

    const response = await fetch("https://example.test/empty");
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(response.headers.get("x-request-id")).toBe("req-empty");
  });

  test("rejects a bodyless Responses event stream without a terminal event", async () => {
    const fetch = createOpenAIStreamFetch(
      "openai-response",
      async () => new Response(null, { headers: { "content-type": "text/event-stream" } }),
    );

    await expect(fetch("https://example.test/empty-stream").then((response) => response.text())).rejects.toThrow(
      /terminal event/i,
    );
  });

  test("preserves representation headers on an unencoded non-SSE response", async () => {
    const fetch = createOpenAIStreamFetch(
      "openai-response",
      async () =>
        new Response("error", {
          status: 400,
          headers: { "content-type": "application/json", "content-length": "5" },
        }),
    );

    const response = await fetch("https://example.test/error");
    expect(response.headers.get("content-length")).toBe("5");
    expect(await response.text()).toBe("error");
  });

  test("preserves representation headers on an identity-encoded non-SSE response", async () => {
    const fetch = createOpenAIStreamFetch(
      "openai-response",
      async () =>
        new Response("error", {
          status: 400,
          headers: {
            "content-type": "application/json",
            "content-encoding": "identity",
            "content-length": "5",
          },
        }),
    );

    const response = await fetch("https://example.test/error");
    expect(response.headers.get("content-encoding")).toBe("identity");
    expect(response.headers.get("content-length")).toBe("5");
    expect(await response.text()).toBe("error");
  });

  test("rejects unsupported encoding before returning a response", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          controller.enqueue(Uint8Array.of(1));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const fetch = createOpenAIStreamFetch("openai-response", async () => {
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          "content-encoding": "lzma",
        },
      });
    });
    await expect(fetch("https://example.test/stream")).rejects.toThrow(/lzma|unsupported|encoding/i);
    expect(pulls).toBe(0);
  });

  test("removes stale Content-Encoding and Content-Length while preserving status and statusText", async () => {
    const encoded = await compress("gzip", encoder.encode(responsesTerminal));
    const fetch = createOpenAIStreamFetch("openai-response", async () => {
      return new Response(encoded, {
        status: 201,
        statusText: "Created",
        headers: {
          "content-type": "text/event-stream",
          "content-encoding": "gzip",
          "content-length": String(encoded.byteLength),
          "x-request-id": "req-1",
        },
      });
    });
    const response = await fetch("https://example.test/stream");
    expect(response.status).toBe(201);
    expect(response.statusText).toBe("Created");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(response.headers.get("x-request-id")).toBe("req-1");
    expect(await response.text()).toBe(responsesTerminal);
  });
});
