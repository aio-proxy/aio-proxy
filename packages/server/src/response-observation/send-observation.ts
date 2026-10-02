import { inheritUpstreamResponseIdentity, upstreamResponseIdentity } from '@aio-proxy/shared';

import { normalizeContentEncoding } from './content-encoding';
import type { AttemptResponseSnapshot, ResponseBodyObservation } from './response-observation';

export type SendResponseSnapshot = AttemptResponseSnapshot & {
  readonly sendIndex: number;
  readonly endedAt: number;
  readonly bodyOutcome?: 'complete' | 'cancelled' | 'error' | 'unconsumed';
  readonly httpStatus?: number;
  readonly error?: unknown;
  readonly retryReason?: 'protocol_rewrite';
  readonly responseSelected?: boolean;
};

export type SendResponseObservation = {
  readonly index: number;
  readonly startedAt: number;
  readonly observeResponse: (response: Response, controlledStream: boolean) => ResponseBodyObservation;
  readonly observeSseEvent: () => void;
  readonly endBody: (outcome: 'complete' | 'cancelled' | 'error', error?: unknown) => void;
  readonly fail: (error: unknown) => void;
  readonly reject: () => void;
  readonly select: () => void;
  readonly observeContent: () => void;
  readonly isContentSource: (includeFailed?: boolean) => boolean;
  readonly onFinish: (finish: (snapshot: SendResponseSnapshot) => void) => void;
  readonly finish: () => void;
};

const responses = new WeakMap<object, SendResponseObservation>();

// Wrappers must transfer identity instead of guessing from the last fetch.
export function inheritObservedResponse(original: Response, wrapped: Response): void {
  inheritUpstreamResponseIdentity(original, wrapped);
}

export function rejectObservedResponse(response: Response): void {
  observedResponseSend(response)?.reject();
}

export function observedResponseSend(response: Response): SendResponseObservation | undefined {
  return responses.get(upstreamResponseIdentity(response));
}

export function createSendResponseObservation(index: number): SendResponseObservation {
  const startedAt = performance.now();
  const elapsed = () => Math.max(0, performance.now() - startedAt);
  let endedAt = performance.timeOrigin + startedAt;
  let transportObservation: 'sse' | 'body' | undefined;
  let upstreamHeadersMs: number | undefined;
  let firstUpstreamByteMs: number | undefined;
  let firstSseEventMs: number | undefined;
  let maxSseFramesPerRead: number | undefined;
  let contentEncoding: AttemptResponseSnapshot['contentEncoding'];
  let bodyOutcome: SendResponseSnapshot['bodyOutcome'];
  let httpStatus: number | undefined;
  let error: unknown;
  let retryReason: SendResponseSnapshot['retryReason'];
  let responseSelected = false;
  let consumed = false;
  let contentObserved = false;
  let finish: ((snapshot: SendResponseSnapshot) => void) | undefined;
  let finished = false;
  const markEnd = () => {
    endedAt = performance.timeOrigin + performance.now();
  };
  const send: SendResponseObservation = {
    index,
    startedAt,
    observeResponse(response, controlledStream) {
      responses.set(upstreamResponseIdentity(response), send);
      httpStatus = response.status;
      transportObservation =
        response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream'
          ? 'sse'
          : 'body';
      upstreamHeadersMs = elapsed();
      markEnd();
      if (response.body === null) bodyOutcome = 'complete';
      if (controlledStream) contentEncoding = normalizeContentEncoding(response.headers.get('content-encoding'));
      return {
        observeRead(byteLength, sseFrames) {
          if (finished || byteLength === 0) return;
          consumed = true;
          markEnd();
          if (!controlledStream) return;
          firstUpstreamByteMs ??= elapsed();
          if (transportObservation === 'sse' && contentEncoding === 'identity') {
            maxSseFramesPerRead = Math.max(maxSseFramesPerRead ?? 0, sseFrames);
          }
        },
      };
    },
    observeSseEvent() {
      if (!finished && transportObservation === 'sse' && contentEncoding === 'identity') firstSseEventMs ??= elapsed();
    },
    endBody(outcome, failure) {
      if (finished || bodyOutcome !== undefined) return;
      bodyOutcome = outcome;
      error = failure;
      markEnd();
    },
    fail(failure) {
      error = failure;
      markEnd();
    },
    reject() {
      retryReason = 'protocol_rewrite';
    },
    select() {
      responseSelected = true;
    },
    observeContent() {
      contentObserved = true;
    },
    isContentSource: (includeFailed = false) =>
      consumed &&
      httpStatus !== undefined &&
      httpStatus >= 200 &&
      httpStatus < 300 &&
      retryReason === undefined &&
      (includeFailed || contentObserved || (bodyOutcome !== 'error' && bodyOutcome !== 'cancelled')),
    onFinish(callback) {
      finish = callback;
    },
    finish() {
      if (finished) return;
      finished = true;
      finish?.({
        sendIndex: index,
        endedAt,
        ...(transportObservation === undefined ? {} : { transportObservation }),
        ...(upstreamHeadersMs === undefined ? {} : { upstreamHeadersMs }),
        ...(firstUpstreamByteMs === undefined ? {} : { firstUpstreamByteMs }),
        ...(firstSseEventMs === undefined ? {} : { firstSseEventMs }),
        ...(maxSseFramesPerRead === undefined ? {} : { maxSseFramesPerRead }),
        ...(contentEncoding === undefined ? {} : { contentEncoding }),
        ...(httpStatus === undefined ? {} : { httpStatus, bodyOutcome: bodyOutcome ?? 'unconsumed' }),
        ...(error === undefined ? {} : { error }),
        ...(retryReason === undefined ? {} : { retryReason }),
        ...(responseSelected ? { responseSelected } : {}),
      });
      finish = undefined;
    },
  };
  return send;
}
