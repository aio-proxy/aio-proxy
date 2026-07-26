import type { ContentDecodedReader, DecodedRead } from './content-decoding';
import { createContentDecodedReader } from './content-decoding';

export const encoder = new TextEncoder();
export const decoder = new TextDecoder();

export function decodedFromChunks(reads: readonly DecodedRead[]): ContentDecodedReader {
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

export function sourceFromText(...parts: string[]): ContentDecodedReader {
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

export async function readBody(body: ReadableStream<Uint8Array>): Promise<string> {
  return decoder.decode(await new Response(body).arrayBuffer());
}

export async function readBodyResult(body: ReadableStream<Uint8Array>): Promise<{ text: string; error?: unknown }> {
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
