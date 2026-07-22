import { describe, expect, test } from "bun:test";

import type { ContentDecodedReader, DecodedRead } from "./content-decoding";

import { createContentDecodedReader } from "./content-decoding";
import { createOpenAISseBody } from "./sse-terminal";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function readBody(body: ReadableStream<Uint8Array>): Promise<string> {
  return decoder.decode(await new Response(body).arrayBuffer());
}

async function readBodyResult(body: ReadableStream<Uint8Array>): Promise<{ text: string; error?: unknown }> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    return { text: decoder.decode(Buffer.concat(parts.map((part) => Buffer.from(part)))) };
  } catch (error) {
    return {
      text: decoder.decode(Buffer.concat(parts.map((part) => Buffer.from(part)))),
      error,
    };
  }
}

describe("createOpenAISseBody review regressions", () => {
  test("classifies bare-CR Responses terminal in one pull before a late source error", async () => {
    const terminal = 'event: response.completed\rdata: {"type":"response.completed"}\r\r';
    let pulls = 0;
    let cancelled = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          if (pulls === 1) {
            controller.enqueue(encoder.encode(terminal));
            return;
          }
          controller.error(new TypeError("late source error"));
        },
        cancel() {
          cancelled += 1;
        },
      },
      { highWaterMark: 0 },
    );

    const text = await readBody(createOpenAISseBody(createContentDecodedReader(source, null), "openai-response"));
    expect(text).toBe(terminal);
    expect(pulls).toBe(1);
    expect(cancelled).toBe(1);
  });

  test("completes after terminal even when upstream cancel never resolves", async () => {
    const terminal = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
    const decoded: ContentDecodedReader = {
      async read(): Promise<DecodedRead> {
        return { chunks: [encoder.encode(terminal)], done: false };
      },
      cancel() {
        return new Promise(() => undefined);
      },
    };

    const raced = await Promise.race([
      readBody(createOpenAISseBody(decoded, "openai-response")).then((text) => ({ text })),
      Bun.sleep(100).then(() => ({ timeout: true as const })),
    ]);
    expect(raced).toEqual({ text: terminal });
  });

  test("cancels decoded reader when a pre-terminal error reaches the consumer", async () => {
    let cancelled = 0;
    const decoded: ContentDecodedReader = {
      async read(): Promise<DecodedRead> {
        return {
          chunks: [encoder.encode("data: partial\n\n")],
          done: false,
          error: new Error("pre-terminal decoder failure"),
        };
      },
      async cancel() {
        cancelled += 1;
      },
    };

    const { text, error } = await readBodyResult(createOpenAISseBody(decoded, "openai-compatible"));
    expect(text).toBe("data: partial\n\n");
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/pre-terminal decoder failure/);
    expect(cancelled).toBe(1);
  });
});
