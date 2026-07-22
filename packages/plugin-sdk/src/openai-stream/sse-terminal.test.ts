import { describe, expect, test } from "bun:test";

import type { ContentDecodedReader, DecodedRead } from "./content-decoding";

import { createContentDecodedReader } from "./content-decoding";
import { createOpenAISseBody } from "./sse-terminal";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function decodedFromChunks(reads: readonly DecodedRead[]): ContentDecodedReader {
  let index = 0;
  let cancelled = false;
  return {
    async read() {
      if (cancelled || index >= reads.length) return { chunks: [], done: true };
      const next = reads[index]!;
      index += 1;
      return next;
    },
    async cancel() {
      cancelled = true;
    },
  };
}

function sourceFromText(...parts: string[]): ContentDecodedReader {
  return createContentDecodedReader(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(encoder.encode(part));
        controller.close();
      },
    }),
    null,
  );
}

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

describe("createOpenAISseBody terminals", () => {
  test("recognizes every OpenAI Responses terminal type from event name or data.type", async () => {
    const terminals = [
      "response.completed",
      "response.incomplete",
      "response.failed",
      "response.cancelled",
      "response.done",
      "error",
    ] as const;

    for (const type of terminals) {
      const byEvent = `event: ${type}\ndata: {"ok":true}\n\n`;
      const byDataType = `data: ${JSON.stringify({ type })}\n\n`;
      for (const frame of [byEvent, byDataType]) {
        const text = await readBody(createOpenAISseBody(sourceFromText(frame), "openai-response"));
        expect(text).toBe(frame);
      }
    }
  });

  test("recognizes only exact [DONE] as the OpenAI-compatible terminal", async () => {
    const done = "data: [DONE]\n\n";
    expect(await readBody(createOpenAISseBody(sourceFromText(done), "openai-compatible"))).toBe(done);

    const nearMisses = ["data: [DONE] \n\n", "data: done\n\n", "data: [done]\n\n", "data:DONE\n\n"];
    for (const frame of nearMisses) {
      const { text, error } = await readBodyResult(createOpenAISseBody(sourceFromText(frame), "openai-compatible"));
      expect(error).toBeUndefined();
      expect(text).toBe(frame);
    }
  });

  test("preserves LF, CRLF, bare CR, mixed line endings, split delimiters, and split UTF-8 bytes", async () => {
    const terminal = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
    const cases = [
      "data: one\n\nevent: response.completed\ndata: {}\n\n",
      "data: one\r\n\r\nevent: response.completed\r\ndata: {}\r\n\r\n",
      "data: one\r\revent: response.completed\rdata: {}\r\r",
      "data: one\r\n\nevent: response.completed\ndata: {}\n\n",
    ];

    for (const payload of cases) {
      expect(await readBody(createOpenAISseBody(sourceFromText(payload), "openai-response"))).toBe(payload);
    }

    const mid = Math.floor(terminal.length / 2);
    const splitText = await readBody(
      createOpenAISseBody(sourceFromText(terminal.slice(0, mid), terminal.slice(mid)), "openai-response"),
    );
    expect(splitText).toBe(terminal);

    const snowman = "data: ☃\n\nevent: response.completed\ndata: {}\n\n";
    const snowmanBytes = encoder.encode(snowman);
    // Split inside the 3-byte UTF-8 snowman (U+2603).
    const snowmanOffset = snowmanBytes.indexOf(0xe2) + 1;
    const decoded = createContentDecodedReader(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(snowmanBytes.subarray(0, snowmanOffset));
          controller.enqueue(snowmanBytes.subarray(snowmanOffset));
          controller.close();
        },
      }),
      null,
    );
    expect(await readBody(createOpenAISseBody(decoded, "openai-response"))).toBe(snowman);
  });

  test("forwards bytes only through the first terminal frame when later events share the same batch", async () => {
    const first = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
    const later = "data: should-not-forward\n\n";
    const text = await readBody(
      createOpenAISseBody(
        decodedFromChunks([{ chunks: [encoder.encode(first + later)], done: false }]),
        "openai-response",
      ),
    );
    expect(text).toBe(first);
    expect(text).not.toContain("should-not-forward");
  });

  test("lets a terminal frame win over a decoder error returned with the same batch", async () => {
    const terminal = 'event: response.completed\ndata: {"type":"response.completed"}\n\n';
    const { text, error } = await readBodyResult(
      createOpenAISseBody(
        decodedFromChunks([
          {
            chunks: [encoder.encode(terminal)],
            done: false,
            error: new Error("same-batch decoder failure"),
          },
        ]),
        "openai-response",
      ),
    );
    expect(text).toBe(terminal);
    expect(error).toBeUndefined();
  });

  test("rejects Responses clean EOF and an incomplete terminal frame at EOF", async () => {
    const clean = await readBodyResult(createOpenAISseBody(sourceFromText("data: hello\n\n"), "openai-response"));
    expect(clean.error).toBeInstanceOf(Error);
    expect(String(clean.error)).toMatch(/ended before a terminal event/i);

    const incomplete = await readBodyResult(
      createOpenAISseBody(sourceFromText("event: response.completed\ndata: {"), "openai-response"),
    );
    expect(incomplete.error).toBeInstanceOf(Error);
    expect(String(incomplete.error)).toMatch(/ended before a terminal event/i);
  });

  test("allows OpenAI-compatible clean EOF without [DONE], forwards an unterminated final frame unchanged, but does not hide an error before [DONE]", async () => {
    const clean = await readBodyResult(createOpenAISseBody(sourceFromText("data: hello\n\n"), "openai-compatible"));
    expect(clean.error).toBeUndefined();
    expect(clean.text).toBe("data: hello\n\n");

    const unterminated = "data: trailing-without-delimiter";
    const trailing = await readBodyResult(createOpenAISseBody(sourceFromText(unterminated), "openai-compatible"));
    expect(trailing.error).toBeUndefined();
    expect(trailing.text).toBe(unterminated);

    const beforeDone = await readBodyResult(
      createOpenAISseBody(
        decodedFromChunks([
          {
            chunks: [encoder.encode("data: partial\n\n")],
            done: false,
            error: new Error("decoder failed before DONE"),
          },
        ]),
        "openai-compatible",
      ),
    );
    expect(beforeDone.text).toBe("data: partial\n\n");
    expect(beforeDone.error).toBeInstanceOf(Error);
    expect(String(beforeDone.error)).toMatch(/decoder failed before DONE/);
  });
});
