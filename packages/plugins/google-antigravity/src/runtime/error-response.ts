const MAX_INSPECTION_BYTES = 64 * 1_024;
const MAX_INSPECTION_MS = 100;
const inspectionTimedOut = Symbol("inspection-timed-out");

type ReadState = {
  done: boolean;
};

type ErrorEnvelope = {
  readonly error?: unknown;
};

type ErrorPayload = {
  readonly message?: unknown;
};

export async function hasExplicitNoCapacity(response: Response, signal?: AbortSignal): Promise<boolean> {
  const body = response.clone().body;
  if (body === null) return false;
  const reader = body.getReader();
  const state: ReadState = { done: false };
  const reading = readBounded(reader, state);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const interrupted = new Promise<typeof inspectionTimedOut>((resolve, reject) => {
    timeout = setTimeout(() => resolve(inspectionTimedOut), MAX_INSPECTION_MS);
    if (signal === undefined) return;
    abort = () => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
  });

  try {
    throwIfAborted(signal);
    const bytes = await Promise.race([reading, interrupted]);
    if (bytes === inspectionTimedOut || bytes === undefined) return false;
    return explicitNoCapacity(bytes);
  } catch {
    throwIfAborted(signal);
    return false;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    if (!state.done) {
      void reader.cancel().catch(() => undefined);
      await reading.catch(() => undefined);
    }
    reader.releaseLock();
  }
}

async function readBounded(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: ReadState,
): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) {
      state.done = true;
      return concatenate(chunks, length);
    }
    length += chunk.value.byteLength;
    if (length > MAX_INSPECTION_BYTES) return undefined;
    chunks.push(chunk.value);
  }
}

function concatenate(chunks: readonly Uint8Array[], length: number): Uint8Array {
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function explicitNoCapacity(bytes: Uint8Array): boolean {
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const error = (record(payload) as ErrorEnvelope | undefined)?.error;
    const message = (record(error) as ErrorPayload | undefined)?.message;
    return typeof message === "string" && message.toLowerCase().includes("no capacity");
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  const reason: unknown = signal.reason;
  return reason ?? new DOMException("The operation was aborted", "AbortError");
}
