import type { UsageRow } from '@aio-proxy/types';

import { type PassthroughObservation } from '../../passthrough-usage';
import { isAbortError } from '../../route-observation';
import type { ServerLogSink } from '../../server-log';
import {
  type Captured,
  createIdleTimer,
  deferred,
  type IdleTimer,
  type PassthroughUsageOptions,
  STREAM_IDLE_TIMEOUT_MS,
  ttftProperty,
  type UsageCompletion,
  usageProperty,
} from '../shared';
import { finalizeUsage } from '../usage-validation';
import { createObservationSource } from './observation-source';

// Non-2xx and body-less responses have no stream to observe: resolve completion
// immediately and hand the response through unchanged. A body-less 2xx success
// still routes through finalizeUsage so a configured flat per-request fee
// (cost.request) is billed even with no token usage; failures never bill.
function nonStreamingCompletion(response: Response, ctx: PassthroughUsageContext): Captured<Response> | undefined {
  if (response.status < 200 || response.status >= 400) {
    return { value: response, completion: Promise.resolve({ outcome: 'failure', statusCode: response.status }) };
  }
  if (response.body === null) {
    return { value: response, completion: bodyLessSuccess(response.status, ctx) };
  }
  return undefined;
}

// A body-less success has no observation, so seed an empty observation:
// finalizePassthroughUsage passes usage: undefined and seedForRequestFee bills
// the flat request fee when configured (otherwise no phantom usage row).
async function bodyLessSuccess(statusCode: number, ctx: PassthroughUsageContext): Promise<UsageCompletion> {
  const usage = await finalizePassthroughUsage({}, ctx);
  return { outcome: 'success', statusCode, ...usageProperty(usage) };
}

export function passthroughCapture(
  {
    response,
    protocol,
    providerId,
    modelId,
    requestedModelId,
    onResponseId,
    onCommit,
    startedAt,
    observation,
    idleTimeoutMs,
    configPrice,
  }: PassthroughUsageOptions,
  logger: ServerLogSink | undefined,
): Captured<Response> {
  const shortCircuit = nonStreamingCompletion(response, {
    providerId,
    modelId,
    protocol,
    requestedModelId,
    configPrice,
    logger,
  });
  if (shortCircuit !== undefined) return shortCircuit;

  const statusCode = response.status;
  const terminal = deferred<UsageCompletion>();
  // Non-null: nonStreamingCompletion short-circuits when response.body is null.
  const reader = response.body!.getReader();
  const isSse = response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') === true;
  let firstTokenAt: number | undefined;
  // Trace settlement (usage/timing/outcome) and transport lifecycle (reader +
  // client stream) are tracked separately: a terminal frame settles the trace
  // early, but the transport stays live until EOF/cancel/idle. Conflating them
  // let a post-terminal cancel overwrite a success, and disabled the idle timer
  // once a terminal frame arrived.
  let traceSettled = false;
  let transportClosed = false;
  let idleAborted = false;
  const releaseReader = () => {
    if (transportClosed) return;
    transportClosed = true;
    reader.releaseLock();
  };
  const idle = createIdleTimer(idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS, () => {
    if (transportClosed) return;
    idleAborted = true;
    // The trace may already be settled (terminal frame seen); only fill in a
    // failure outcome if it is not, but always tear down the stalled transport.
    if (!traceSettled) {
      traceSettled = true;
      terminal.resolve({
        outcome: 'failure',
        statusCode,
        errorCode: 'stream_idle_timeout',
        ...ttftProperty(startedAt, firstTokenAt),
      });
    }
    void reader.cancel(new Error('stream_idle_timeout')).catch(() => {});
    releaseReader();
  });
  let committed = false;
  // Commit the session response only once the client has drained the stream to
  // EOF. A client that cancels before EOF must not commit — so the session
  // commit is an EOF-only side effect, separate from the trace response ID
  // (captured at the terminal frame in `complete`).
  const commit = (obs: PassthroughObservation): void => {
    if (committed || obs.failed === true || obs.responseId === undefined) return;
    committed = true;
    onCommit?.(obs.responseId);
  };
  const complete = async (obs: PassthroughObservation): Promise<void> => {
    if (traceSettled) return;
    // Decide the trace outcome synchronously (before any await) so a cancel or
    // idle fire racing the async usage lookup cannot overwrite it.
    traceSettled = true;
    idle.clear();
    if (obs.failed === true) {
      terminal.resolve({ outcome: 'failure', statusCode, ...ttftProperty(startedAt, firstTokenAt) });
      return;
    }
    // Capture the response ID for trace persistence at the terminal frame, before
    // resolving completion — settleSuccess samples it when completion resolves, so
    // a trace whose terminal frame precedes EOF still records its response ID.
    if (obs.responseId !== undefined) onResponseId?.(obs.responseId);
    const usage = await finalizePassthroughUsage(obs, {
      providerId,
      modelId,
      protocol,
      requestedModelId,
      configPrice,
      logger,
    });
    terminal.resolve({
      outcome: 'success',
      statusCode,
      ...usageProperty(usage),
      ...ttftProperty(startedAt, firstTokenAt),
    });
  };
  const source = createObservationSource(isSse, protocol, observation, {
    onContent: (contentAt) => (firstTokenAt ??= contentAt),
    onTerminal: (obs) => void complete(obs),
  });
  const returnedBody = createTeeBody({
    reader,
    idle,
    releaseReader,
    aborted: () => idleAborted,
    onChunk: (chunk) => source.feed(chunk),
    onEnd: async () => {
      const finalObservation = source.final();
      commit(finalObservation);
      await complete(finalObservation);
    },
    onError: (error) => {
      idle.clear();
      if (traceSettled) return;
      traceSettled = true;
      terminal.resolve({
        outcome: isAbortError(error) ? 'cancelled' : 'failure',
        statusCode,
        ...ttftProperty(startedAt, firstTokenAt),
      });
    },
    onCancel: () => {
      idle.clear();
      // A cancel after the trace already settled (e.g. client disconnects just
      // after the terminal frame) must not overwrite the recorded outcome.
      if (traceSettled) return;
      traceSettled = true;
      terminal.resolve({ outcome: 'cancelled', statusCode, ...ttftProperty(startedAt, firstTokenAt) });
    },
  });

  // The idle timer is armed per-read inside the tee, not here: it must measure
  // only the pending upstream read window, never idle client demand between pulls.
  return {
    value: new Response(returnedBody, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    }),
    completion: terminal.promise,
  };
}

type TeeBodyDeps = {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly idle: IdleTimer;
  readonly releaseReader: () => void;
  readonly aborted: () => boolean;
  readonly onChunk: (chunk: Uint8Array) => void;
  readonly onEnd: () => Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly onCancel: () => void;
};

// Tees the upstream body to the client while feeding observation hooks. Chunk
// forwarding is byte-identical; onEnd/onError/onCancel drive completion. The idle
// timer is armed only around the pending upstream `reader.read()` so the timeout
// measures upstream stalls, not time spent waiting for downstream (client) demand.
function createTeeBody(deps: TeeBodyDeps): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let done = false;
      try {
        deps.idle.arm();
        const next = await deps.reader.read();
        deps.idle.clear();
        if (!next.done) {
          deps.onChunk(next.value);
          controller.enqueue(next.value);
          return;
        }
        done = true;
        // An idle timeout cancels the upstream reader, surfacing here as a normal
        // EOF. Terminate the client stream abnormally so a stalled partial response
        // is not mistaken for a clean, complete one.
        if (deps.aborted()) {
          controller.error(new Error('stream_idle_timeout'));
          return;
        }
        controller.close();
        await deps.onEnd();
      } catch (error) {
        done = true;
        deps.onError(error);
        controller.error(error);
      } finally {
        if (done) deps.releaseReader();
      }
    },
    async cancel(reason) {
      deps.onCancel();
      try {
        await deps.reader.cancel(reason);
      } finally {
        deps.releaseReader();
      }
    },
  });
}

type PassthroughUsageContext = {
  readonly providerId: string;
  readonly modelId: string;
  readonly protocol: PassthroughUsageOptions['protocol'];
  readonly requestedModelId: string | undefined;
  readonly configPrice: PassthroughUsageOptions['configPrice'];
  readonly logger: ServerLogSink | undefined;
};

async function finalizePassthroughUsage(
  obs: PassthroughObservation,
  ctx: PassthroughUsageContext,
): Promise<UsageRow | undefined> {
  return finalizeUsage({
    usage:
      obs.usage === undefined && obs.issues === undefined
        ? undefined
        : { ...obs.usage, providerId: ctx.providerId, modelId: ctx.modelId },
    accounting: { source: 'passthrough', protocol: ctx.protocol },
    providerId: ctx.providerId,
    modelId: ctx.modelId,
    ...(ctx.requestedModelId === undefined ? {} : { requestedModelId: ctx.requestedModelId }),
    ...(ctx.configPrice === undefined ? {} : { configPrice: ctx.configPrice }),
    ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
    ...(obs.issues === undefined ? {} : { issues: obs.issues }),
  });
}
