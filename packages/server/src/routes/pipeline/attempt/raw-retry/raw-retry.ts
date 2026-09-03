import type { RawRetryFrame, RawRetryVerdict } from '@aio-proxy/core';
import { createParser } from 'eventsource-parser';

import { createIdleTimer, MAX_PASSTHROUGH_JSON_BYTES, STREAM_IDLE_TIMEOUT_MS } from '../../../../usage-capture';

const MAX_PREFLIGHT_REPLAY_BYTES = 1024 * 1024;

function inboundAbortError(): Error {
  return new DOMException('The operation was aborted', 'AbortError') as unknown as Error;
}

// Only an inbound abort must propagate. Size and idle limits mean "cannot
// intercept", and the caller streams the original response instead.
function isAbortFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export type RawRetryPreflight =
  | { readonly kind: 'commit'; readonly response: Response }
  | { readonly kind: 'retry'; readonly response: Response };

export type RawRetryGuards = {
  readonly signal: AbortSignal;
  readonly idleTimeoutMs?: number;
  readonly assumeEventStream?: boolean;
};

// Cancels `reader` on an inbound abort or an idle gap, so a pending read cannot
// outlive the client. usageCapture.passthrough installs the normal idle timer
// only after commit, which is why preflight needs its own.
function guardReader(reader: ReadableStreamDefaultReader<Uint8Array>, guards: RawRetryGuards) {
  let failure: Error | undefined;
  const fail = (error: Error) => {
    failure ??= error;
    void reader.cancel(error).catch(() => undefined);
  };
  const idle = createIdleTimer(guards.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS, () => {
    fail(new Error('Upstream stream stalled before the raw retry verdict'));
  });
  const onAbort = () => fail(inboundAbortError());
  if (guards.signal.aborted) onAbort();
  else guards.signal.addEventListener('abort', onAbort, { once: true });
  return {
    arm: idle.arm,
    failure: () => failure,
    release: () => {
      idle.clear();
      guards.signal.removeEventListener('abort', onAbort);
    },
  };
}

export async function preflightRawRetrySse(
  response: Response,
  classify: (frame: RawRetryFrame) => RawRetryVerdict,
  guards: RawRetryGuards,
): Promise<RawRetryPreflight> {
  // A streaming provider may omit Content-Type; raw.ts's withEventStreamContentType
  // adds it only after this resolver, so treat a missing header as SSE when the
  // pipeline asked for a stream. A header that names another type is honored.
  const contentType = response.headers.get('content-type');
  const eventStream =
    contentType === null ? guards.assumeEventStream === true : contentType.toLowerCase().includes('text/event-stream');
  if (response.body === null || !eventStream) {
    return { kind: 'commit', response };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const buffered: Uint8Array[] = [];
  let bufferedBytes = 0;
  let verdict: RawRetryVerdict = 'hold';
  const parser = createParser({
    onEvent(event) {
      if (verdict !== 'hold') return;
      verdict = classify(event.event === undefined ? { data: event.data } : { event: event.event, data: event.data });
    },
  });
  const guard = guardReader(reader, guards);

  let done = false;
  try {
    guard.arm();
    while (verdict === 'hold' && !done) {
      const chunk = await reader.read();
      const failure = guard.failure();
      if (failure !== undefined) throw failure;
      guard.arm();
      done = chunk.done;
      if (chunk.value !== undefined) {
        buffered.push(chunk.value);
        bufferedBytes += chunk.value.byteLength;
        parser.feed(decoder.decode(chunk.value, { stream: true }));
        // The cap wins over whatever this chunk classified as. A single
        // provider-controlled chunk can be arbitrarily large and may carry the
        // retryable error itself, so checking `verdict === 'hold'` first would
        // let an oversized body through the advertised replay bound.
        if (bufferedBytes > MAX_PREFLIGHT_REPLAY_BYTES) verdict = 'commit';
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw guard.failure() ?? error;
  } finally {
    guard.release();
  }

  const next = new Response(replayBuffered(reader, buffered, done), {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
  return { kind: verdict === 'retry' ? 'retry' : 'commit', response: next };
}

export async function readBoundedJsonBody(response: Response, guards: RawRetryGuards): Promise<string | undefined> {
  const contentType = response.headers.get('content-type') ?? '';
  if (response.body === null || !contentType.toLowerCase().includes('application/json')) return undefined;

  // `response.clone()` tees the body. Never await a cancel on this branch: the
  // tee-wide promise does not settle until the preserved original branch is also
  // drained or cancelled, and the caller cannot return that original until this
  // function resolves. Awaiting would deadlock a large or never-ending 400.
  const reader = response.clone().body!.getReader();
  const abandon = () => {
    void reader.cancel().catch(() => undefined);
  };
  const guard = guardReader(reader, guards);
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    guard.arm();
    for (;;) {
      const chunk = await reader.read();
      const failure = guard.failure();
      // An inbound abort is not a "cannot intercept" case: swallowing it would
      // make completeRawAttempt record an ordinary provider failure instead of
      // letting handleAttemptError see the cancellation.
      if (isAbortFailure(failure)) throw failure;
      if (failure !== undefined) return undefined;
      guard.arm();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_PASSTHROUGH_JSON_BYTES) {
        abandon();
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } catch (error) {
    abandon();
    if (isAbortFailure(error)) throw error;
    return undefined;
  } finally {
    guard.release();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function replayBuffered(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  buffered: readonly Uint8Array[],
  sourceDone: boolean,
): ReadableStream<Uint8Array> {
  let index = 0;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      reader.releaseLock();
    } catch {}
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < buffered.length) {
        controller.enqueue(buffered[index]!);
        index += 1;
        return;
      }
      if (sourceDone) {
        release();
        controller.close();
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) {
          release();
          controller.close();
        } else controller.enqueue(next.value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}
