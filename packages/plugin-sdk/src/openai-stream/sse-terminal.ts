import { createParser } from "eventsource-parser";

import type { ProtocolId } from "../runtime";
import type { ContentDecodedReader } from "./content-decoding";

export type OpenAIStreamProtocol = Extract<ProtocolId, "openai-response" | "openai-compatible">;

const responsesTerminalTypes = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
  "response.cancelled",
  "response.done",
  "error",
]);

const textDecoder = new TextDecoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isResponsesTerminal(event: { readonly event?: string; readonly data: string }): boolean {
  if (event.event !== undefined && responsesTerminalTypes.has(event.event)) return true;
  try {
    const value: unknown = JSON.parse(event.data);
    return isRecord(value) && typeof value["type"] === "string" && responsesTerminalTypes.has(value["type"]);
  } catch {
    return false;
  }
}

function isCompatibleTerminal(event: { readonly data: string }): boolean {
  return event.data === "[DONE]";
}

function isTerminal(
  event: { readonly event?: string; readonly data: string },
  protocol: OpenAIStreamProtocol,
): boolean {
  return protocol === "openai-response" ? isResponsesTerminal(event) : isCompatibleTerminal(event);
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 0) return new Uint8Array(0);
  if (parts.length === 1) return parts[0]!;
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.byteLength;
  }
  return merged;
}

/**
 * Next line ending at or after `from`.
 * A trailing CR already ends the SSE line even if an LF might follow later.
 */
function findLineEnding(bytes: Uint8Array, from: number): { readonly start: number; readonly end: number } | null {
  for (let i = from; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (byte === 0x0a) return { start: i, end: i + 1 };
    if (byte === 0x0d) {
      if (i + 1 < bytes.length && bytes[i + 1] === 0x0a) return { start: i, end: i + 2 };
      return { start: i, end: i + 1 };
    }
  }
  return null;
}

/** Byte index immediately after the blank line that ends the next SSE frame. */
function findFrameEnd(bytes: Uint8Array): number | null {
  let offset = 0;
  while (offset < bytes.length) {
    const ending = findLineEnding(bytes, offset);
    if (ending === null) return null;
    if (ending.start === offset) return ending.end;
    offset = ending.end;
  }
  return null;
}

function parseFrame(frameBytes: Uint8Array): { readonly event?: string; readonly data: string } | undefined {
  let parsed: { readonly event?: string; readonly data: string } | undefined;
  const parser = createParser({
    onEvent(event) {
      parsed = event.event === undefined ? { data: event.data } : { event: event.event, data: event.data };
    },
  });
  // Normalize only for classification; outbound frame bytes stay byte-identical.
  const normalized = textDecoder.decode(frameBytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  parser.feed(normalized);
  return parsed;
}

function ignoreCancel(decoded: ContentDecodedReader, reason: unknown): void {
  // Consumer completion must not await cancel — a hung upstream cancel must not block close.
  void decoded.cancel(reason).catch(() => undefined);
}

export function createOpenAISseBody(
  decoded: ContentDecodedReader,
  protocol: OpenAIStreamProtocol,
): ReadableStream<Uint8Array> {
  let carry = new Uint8Array(0);
  let finished = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;

      // Read until we can enqueue, terminate, error, or close. Incomplete carries must not stall.
      while (!finished) {
        const read = await decoded.read();
        const batch = concatBytes(carry.byteLength === 0 ? [...read.chunks] : [carry, ...read.chunks]);
        carry = new Uint8Array(0);

        let offset = 0;
        let terminalFound = false;
        const outbound: Uint8Array[] = [];

        while (offset < batch.byteLength) {
          const remaining = batch.subarray(offset);
          const frameEnd = findFrameEnd(remaining);
          if (frameEnd === null) {
            carry = remaining.slice();
            break;
          }
          const frameBytes = remaining.subarray(0, frameEnd);
          outbound.push(frameBytes);
          offset += frameEnd;
          const event = parseFrame(frameBytes);
          if (event !== undefined && isTerminal(event, protocol)) {
            terminalFound = true;
            carry = new Uint8Array(0);
            break;
          }
        }

        for (const chunk of outbound) controller.enqueue(chunk);

        if (terminalFound) {
          finished = true;
          ignoreCancel(decoded, "OpenAI protocol terminal reached");
          controller.close();
          return;
        }
        if (read.error !== undefined) {
          finished = true;
          ignoreCancel(decoded, read.error);
          controller.error(read.error);
          return;
        }
        if (read.done && protocol === "openai-response") {
          finished = true;
          ignoreCancel(decoded, "OpenAI Responses stream ended before a terminal event");
          controller.error(new Error("OpenAI Responses stream ended before a terminal event"));
          return;
        }
        if (read.done) {
          finished = true;
          if (carry.byteLength > 0) controller.enqueue(carry);
          carry = new Uint8Array(0);
          ignoreCancel(decoded, "OpenAI-compatible stream ended");
          controller.close();
          return;
        }
        if (outbound.length > 0) return;
      }
    },

    async cancel(reason) {
      finished = true;
      await decoded.cancel(reason);
    },
  });
}
