import { createParser } from "eventsource-parser";

import type { AntigravityFailureReason } from "./errors";

type PreflightEvent =
  | { readonly kind: "model" }
  | { readonly kind: "terminal-error" }
  | { readonly kind: "retryable-error"; readonly reason: AntigravityFailureReason; readonly status: number };

type CcaEventPayload = Record<string, unknown> & {
  readonly error?: unknown;
  readonly response?: unknown;
};

type CcaErrorPayload = {
  readonly code?: unknown;
  readonly message?: unknown;
};

export type CcaSsePreflight = {
  readonly response: Response;
  readonly event?: PreflightEvent;
};

type StreamReaderOwner = {
  readonly read: () => ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>;
  readonly cancel: (reason?: unknown) => Promise<void>;
  readonly fail: (reason?: unknown) => Promise<void>;
  readonly release: () => void;
};

const encoder = new TextEncoder();
const MAX_PREFLIGHT_REPLAY_BYTES = 1024 * 1024;
const MAX_PARSER_BUFFER_CHARS = 1024 * 1024;
const MAX_QUEUED_FRAME_BYTES = 1024 * 1024;

export function unwrapCcaSse(
  stream: ReadableStream<Uint8Array>,
  options: { readonly signal?: AbortSignal; readonly terminateOnError?: boolean } = {},
): ReadableStream<Uint8Array> {
  const owner = createReaderOwner(stream.getReader());
  const decoder = new TextDecoder();
  const queued: Uint8Array[] = [];
  let queuedBytes = 0;
  let ended = false;
  let failure: Error | undefined;
  const invalidate = () => {
    if (failure !== undefined) return;
    queued.length = 0;
    queuedBytes = 0;
    failure = invalidStream();
  };
  const enqueue = (payload: unknown) => {
    const output = frame(payload);
    if (queuedBytes + output.byteLength > MAX_QUEUED_FRAME_BYTES) {
      invalidate();
      return;
    }
    queued.push(output);
    queuedBytes += output.byteLength;
  };
  const parser = createParser({
    maxBufferSize: MAX_PARSER_BUFFER_CHARS,
    onEvent(event) {
      if (failure !== undefined) return;
      if (event.data.length > MAX_PARSER_BUFFER_CHARS) {
        invalidate();
        return;
      }
      const payload = parseEvent(event.data);
      if (payload === undefined) {
        invalidate();
        return;
      }
      if (payload.response !== undefined && payload.response !== null) {
        enqueue(payload.response);
      } else if ("error" in payload) {
        if (options.terminateOnError === true) {
          failure = new Error("Google Antigravity stream failed");
        } else {
          enqueue(payload);
        }
      }
    },
    onError() {
      invalidate();
    },
  });

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (queued.length === 0 && !ended && failure === undefined) {
          const chunk = await owner.read();
          if (chunk.done) {
            const tail = decoder.decode();
            if (tail !== "") parser.feed(tail);
            parser.reset({ consume: true });
            ended = true;
          } else {
            parser.feed(decoder.decode(chunk.value, { stream: true }));
          }
        }
        const next = queued.shift();
        if (next !== undefined) {
          queuedBytes -= next.byteLength;
          controller.enqueue(next);
        } else if (failure !== undefined) {
          const reason = failureReason(failure, options.signal);
          await owner.fail(reason);
          controller.error(reason);
        } else if (ended) {
          owner.release();
          controller.close();
        }
      } catch (error) {
        const reason = failureReason(error, options.signal);
        await owner.fail(reason);
        controller.error(reason);
      }
    },
    cancel: owner.cancel,
  });
}

export async function preflightCcaSse(response: Response): Promise<CcaSsePreflight> {
  if (response.body === null) return { response };
  const owner = createReaderOwner(response.body.getReader());
  const decoder = new TextDecoder();
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let event: PreflightEvent | undefined;
  let done = false;
  let failure: Error | undefined;
  const parser = createParser({
    maxBufferSize: MAX_PARSER_BUFFER_CHARS,
    onEvent(message) {
      if (event !== undefined || failure !== undefined) return;
      if (message.data.length > MAX_PARSER_BUFFER_CHARS) {
        failure = invalidStream();
        return;
      }
      const payload = parseEvent(message.data);
      if (payload === undefined) {
        failure = invalidStream();
        return;
      }
      event = classifyEvent(payload);
    },
    onError() {
      failure ??= invalidStream();
    },
  });

  try {
    while (event === undefined && !done && failure === undefined) {
      const chunk = await owner.read();
      done = chunk.done;
      if (chunk.value !== undefined) {
        if (bufferedBytes + chunk.value.byteLength > MAX_PREFLIGHT_REPLAY_BYTES) throw invalidStream();
        buffered.push(chunk.value);
        bufferedBytes += chunk.value.byteLength;
        parser.feed(decoder.decode(chunk.value, { stream: true }));
      }
    }

    if (failure !== undefined) throw failure;
    if (done) owner.release();
    const replay = replayStream(owner, buffered, done);
    return {
      response: new Response(replay, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      }),
      ...(event === undefined ? {} : { event }),
    };
  } catch (error) {
    await owner.fail(error);
    throw error;
  }
}

function replayStream(
  owner: StreamReaderOwner,
  buffered: readonly Uint8Array[],
  alreadyDone: boolean,
): ReadableStream<Uint8Array> {
  let index = 0;
  let done = alreadyDone;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = buffered[index++];
        if (chunk !== undefined) {
          controller.enqueue(chunk);
          return;
        }
        if (done) {
          owner.release();
          controller.close();
          return;
        }
        const next = await owner.read();
        done = next.done;
        if (next.value !== undefined) controller.enqueue(next.value);
        if (done) {
          owner.release();
          controller.close();
        }
      } catch (error) {
        await owner.fail(error);
        controller.error(error);
      }
    },
    cancel: owner.cancel,
  });
}

function createReaderOwner(reader: ReadableStreamDefaultReader<Uint8Array>): StreamReaderOwner {
  let state: "active" | "canceling" | "released" = "active";
  const release = () => {
    if (state !== "active") return;
    state = "released";
    reader.releaseLock();
  };
  const cancel = async (reason?: unknown) => {
    if (state !== "active") return;
    state = "canceling";
    try {
      await reader.cancel(reason);
    } finally {
      state = "released";
      reader.releaseLock();
    }
  };
  return {
    read: async () => await reader.read(),
    cancel,
    fail: async (reason) => {
      await cancel(reason).catch(() => undefined);
    },
    release,
  };
}

function classifyEvent(payload: CcaEventPayload): PreflightEvent | undefined {
  if (payload.response !== undefined && payload.response !== null) return { kind: "model" };
  if (!("error" in payload)) return undefined;
  const error = errorPayload(payload.error);
  const status = number(error?.code);
  const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
  if (status === 429) return { kind: "retryable-error", reason: "upstream_rate_limited", status };
  if (status === 503 && message.includes("no capacity")) {
    return { kind: "retryable-error", reason: "upstream_no_capacity", status };
  }
  return { kind: "terminal-error" };
}

function parseEvent(data: string): CcaEventPayload | undefined {
  try {
    return record(JSON.parse(data)) as CcaEventPayload | undefined;
  } catch {
    return undefined;
  }
}

function frame(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function invalidStream(): TypeError {
  return new TypeError("Google Antigravity returned an invalid event stream");
}

function failureReason(failure: unknown, signal: AbortSignal | undefined): unknown {
  if (signal?.aborted !== true) return failure;
  const reason: unknown = signal.reason;
  return reason ?? new DOMException("The operation was aborted", "AbortError");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorPayload(value: unknown): CcaErrorPayload | undefined {
  return record(value) as CcaErrorPayload | undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}
