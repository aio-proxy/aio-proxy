import { describe, expect, test } from "bun:test";

import { createOpenAIStreamFetch } from "./openai-stream-fetch";

const encoder = new TextEncoder();
const terminal = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';

describe("createOpenAIStreamFetch Bun transport", () => {
  test("native Bun fetch resolves a zstd terminal before a corrupt continuation", async () => {
    let releaseContinuation: () => void = () => undefined;
    const continuationGate = new Promise<void>((resolve) => {
      releaseContinuation = resolve;
    });
    let pulls = 0;
    let continuationReleased = false;
    let acceptEncoding: string | null = null;
    const encodedTerminal = Bun.zstdCompressSync(encoder.encode(terminal));
    const body = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(encodedTerminal);
            return;
          }
          await continuationGate;
          continuationReleased = true;
          controller.enqueue(Uint8Array.of(0xff, 0x00, 0xff));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );

    const server = Bun.serve({
      port: 0,
      fetch(request) {
        acceptEncoding = request.headers.get("accept-encoding");
        return new Response(body, {
          headers: {
            "content-type": "text/event-stream",
            "content-encoding": "zstd",
          },
        });
      },
    });

    try {
      const fetch = createOpenAIStreamFetch("openai-response");
      const response = await Promise.race([
        fetch(`http://127.0.0.1:${server.port}/stream`),
        Bun.sleep(5_000).then(() => {
          throw new Error("timed out waiting for OpenAI stream response");
        }),
      ]);
      const text = await Promise.race([
        response.text(),
        Bun.sleep(5_000).then(() => {
          throw new Error("timed out waiting for OpenAI stream body");
        }),
      ]);
      expect(acceptEncoding).toBe("gzip, deflate, br, zstd");
      expect(text).toBe(terminal);
      expect(continuationReleased).toBe(false);
    } finally {
      releaseContinuation();
      server.stop(true);
    }
  });

  test("resolves a compressed terminal before a second pull that would throw a decode error", async () => {
    let pulls = 0;
    let cancelled = false;
    const encodedTerminal = Bun.gzipSync(encoder.encode(terminal));
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(encodedTerminal);
            return;
          }
          throw new TypeError("error decoding response body");
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );

    const fetch = createOpenAIStreamFetch("openai-response", async () => {
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          "content-encoding": "gzip",
        },
      });
    });

    const response = await fetch("https://example.test/stream");
    expect(pulls).toBe(1);
    expect(await response.text()).toBe(terminal);
    expect(pulls).toBe(1);
    expect(cancelled).toBe(true);
  });
});
