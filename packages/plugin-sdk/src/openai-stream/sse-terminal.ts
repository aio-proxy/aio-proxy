import { isPlainObject } from 'es-toolkit/predicate';
import { createParser } from 'eventsource-parser';

import type { ProtocolId } from '../runtime';
import type { ContentDecodedReader } from './content-decoding';

export type OpenAIStreamProtocol = Extract<ProtocolId, 'openai-response' | 'openai-compatible'>;

export type OpenAISseBodyOptions = {
  readonly normalizeToolArgumentSnapshots?: boolean;
};

const responsesTerminalTypes = new Set([
  'response.completed',
  'response.incomplete',
  'response.failed',
  'response.cancelled',
  'response.done',
  'error',
]);

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

function isResponsesTerminal(
  event: { readonly event?: string; readonly data: string },
  value?: Record<string, unknown>,
): boolean {
  if (event.event !== undefined && responsesTerminalTypes.has(event.event)) return true;
  const parsed = value ?? parseObject(event.data);
  return typeof parsed?.['type'] === 'string' && responsesTerminalTypes.has(parsed['type']);
}

function isCompatibleTerminal(event: { readonly data: string }): boolean {
  return event.data === '[DONE]';
}

function isTerminal(
  event: { readonly event?: string; readonly data: string },
  protocol: OpenAIStreamProtocol,
  responsesValue?: Record<string, unknown>,
): boolean {
  return protocol === 'openai-response' ? isResponsesTerminal(event, responsesValue) : isCompatibleTerminal(event);
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
  const normalized = textDecoder.decode(frameBytes).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  parser.feed(normalized);
  return parsed;
}

function parseObject(data: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(data);
    return isPlainObject(value) && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function responsesCreatedResponse(
  event: {
    readonly event?: string;
    readonly data: string;
  },
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const created = event.event === 'response.created' || value?.['type'] === 'response.created';
  const response = value?.['response'];
  return created && isPlainObject(response) && !Array.isArray(response) ? response : undefined;
}

function normalizedResponsesErrorFrame(
  event: { readonly event?: string; readonly data: string },
  value: Record<string, unknown> | undefined,
  createdResponse: Record<string, unknown> | undefined,
): Uint8Array | undefined {
  const failed = event.event === 'error' || value?.['type'] === 'error';
  if (!failed || value === undefined || createdResponse === undefined) return undefined;
  const { sequence_number, ...error } = value;
  const payload = {
    type: 'response.failed',
    ...(sequence_number === undefined ? {} : { sequence_number }),
    response: { ...createdResponse, status: 'failed', error },
  };
  return textEncoder.encode(`event: response.failed\ndata: ${JSON.stringify(payload)}\n\n`);
}

type ToolArgumentsState = {
  mode: 'unknown' | 'delta' | 'snapshot';
  value: string;
};

function normalizedCompatibleToolArgumentsFrame(
  event: { readonly event?: string; readonly data: string },
  value: Record<string, unknown> | undefined,
  states: Map<string, ToolArgumentsState>,
): Uint8Array | undefined {
  const choices = value?.['choices'];
  if (!Array.isArray(choices)) return undefined;
  let changed = false;
  const normalizedChoices = choices.map((choice, choiceIndex) => {
    if (!isPlainObject(choice) || !isPlainObject(choice['delta'])) return choice;
    const toolCalls = choice['delta']['tool_calls'];
    if (!Array.isArray(toolCalls)) return choice;
    const normalizedToolCalls = toolCalls.map((toolCall, toolIndex) => {
      if (!isPlainObject(toolCall) || !isPlainObject(toolCall['function'])) return toolCall;
      const args = toolCall['function']['arguments'];
      if (typeof args !== 'string') return toolCall;
      const key = `${String(choice['index'] ?? choiceIndex)}:${String(toolCall['index'] ?? toolIndex)}`;
      const state = states.get(key);
      if (state === undefined) {
        states.set(key, { mode: 'unknown', value: args });
        return toolCall;
      }
      if (state.mode === 'unknown' && args.startsWith(state.value)) state.mode = 'snapshot';
      else if (state.mode === 'unknown') state.mode = 'delta';
      if (state.mode === 'delta') {
        state.value += args;
        return toolCall;
      }
      if (!args.startsWith(state.value)) {
        state.mode = 'delta';
        state.value += args;
        return toolCall;
      }
      const delta = args.slice(state.value.length);
      state.value = args;
      changed = true;
      return { ...toolCall, function: { ...toolCall['function'], arguments: delta } };
    });
    return { ...choice, delta: { ...choice['delta'], tool_calls: normalizedToolCalls } };
  });
  if (!changed || value === undefined) return undefined;
  const eventLine = event.event === undefined ? '' : `event: ${event.event}\n`;
  return textEncoder.encode(`${eventLine}data: ${JSON.stringify({ ...value, choices: normalizedChoices })}\n\n`);
}

function ignoreCancel(decoded: ContentDecodedReader, reason: unknown): void {
  // Consumer completion must not await cancel — a hung upstream cancel must not block close.
  void decoded.cancel(reason).catch(() => undefined);
}

export function createOpenAISseBody(
  decoded: ContentDecodedReader,
  protocol: OpenAIStreamProtocol,
  options: OpenAISseBodyOptions = {},
): ReadableStream<Uint8Array> {
  let carry = new Uint8Array(0);
  let finished = false;
  let pendingError: unknown;
  let createdResponse: Record<string, unknown> | undefined;
  const toolArguments = new Map<string, ToolArgumentsState>();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (finished) return;
      if (pendingError !== undefined) {
        const error = pendingError;
        pendingError = undefined;
        finished = true;
        ignoreCancel(decoded, error);
        controller.error(error);
        return;
      }

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
          offset += frameEnd;
          const event = parseFrame(frameBytes);
          const responsesValue =
            protocol === 'openai-response' && event !== undefined ? parseObject(event.data) : undefined;
          if (protocol === 'openai-response' && event !== undefined) {
            createdResponse = responsesCreatedResponse(event, responsesValue) ?? createdResponse;
          }
          const normalizedFrame =
            event === undefined
              ? undefined
              : protocol === 'openai-response'
                ? normalizedResponsesErrorFrame(event, responsesValue, createdResponse)
                : options.normalizeToolArgumentSnapshots === true
                  ? normalizedCompatibleToolArgumentsFrame(event, parseObject(event.data), toolArguments)
                  : undefined;
          outbound.push(normalizedFrame ?? frameBytes);
          if (event !== undefined && isTerminal(event, protocol, responsesValue)) {
            terminalFound = true;
            carry = new Uint8Array(0);
            break;
          }
        }

        for (const chunk of outbound) controller.enqueue(chunk);

        if (terminalFound) {
          finished = true;
          ignoreCancel(decoded, 'OpenAI protocol terminal reached');
          controller.close();
          return;
        }
        if (read.error !== undefined) {
          if (outbound.length > 0) {
            pendingError = read.error;
            return;
          }
          finished = true;
          ignoreCancel(decoded, read.error);
          controller.error(read.error);
          return;
        }
        if (read.done && protocol === 'openai-response') {
          const error = new Error('OpenAI Responses stream ended before a terminal event');
          if (outbound.length > 0) {
            pendingError = error;
            return;
          }
          finished = true;
          ignoreCancel(decoded, error);
          controller.error(error);
          return;
        }
        if (read.done) {
          finished = true;
          if (carry.byteLength > 0) controller.enqueue(carry);
          carry = new Uint8Array(0);
          ignoreCancel(decoded, 'OpenAI-compatible stream ended');
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
