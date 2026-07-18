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

export function unwrapCcaSse(
  stream: ReadableStream<Uint8Array>,
  options: { readonly signal?: AbortSignal; readonly terminateOnError?: boolean } = {},
): ReadableStream<Uint8Array> {
  const owner = createReaderOwner(stream.getReader());
  const decoder = new TextDecoder();
  const queued: Uint8Array[] = [];
  let ended = false;
  let failure: Error | undefined;
  const parser = createParser({
    onEvent(event) {
      if (failure !== undefined) return;
      const payload = parseEvent(event.data);
      if (payload === undefined) {
        failure = invalidStream();
        return;
      }
      if (payload.response !== undefined && payload.response !== null) {
        queued.push(frame(payload.response));
      } else if ("error" in payload) {
        if (options.terminateOnError === true) {
          failure = new Error("Google Antigravity stream failed");
        } else {
          queued.push(frame(payload));
        }
      }
    },
    onError() {
      failure = invalidStream();
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
  let event: PreflightEvent | undefined;
  let done = false;
  let parseFailed = false;
  const parser = createParser({
    onEvent(message) {
      if (event !== undefined) return;
      const payload = parseEvent(message.data);
      if (payload === undefined) {
        parseFailed = true;
        return;
      }
      event = classifyEvent(payload);
    },
    onError() {
      parseFailed = true;
    },
  });

  try {
    while (event === undefined && !done && !parseFailed) {
      const chunk = await owner.read();
      done = chunk.done;
      if (chunk.value !== undefined) {
        buffered.push(chunk.value);
        parser.feed(decoder.decode(chunk.value, { stream: true }));
      }
    }

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

function invalidStream(): Error {
  return new Error("Google Antigravity returned an invalid event stream");
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
