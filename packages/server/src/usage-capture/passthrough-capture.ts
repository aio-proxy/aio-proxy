import type { UsageRow } from '@aio-proxy/types';

import {
  createPassthroughSseUsageObserver,
  extractPassthroughObservation,
  type PassthroughObservation,
  type PassthroughSseUsageObserver,
} from '../passthrough-usage';
import { isAbortError } from '../route-observation';
import type { ServerLogSink } from '../server-log';
import {
  type Captured,
  createIdleTimer,
  deferred,
  type IdleTimer,
  MAX_PASSTHROUGH_JSON_BYTES,
  observeContentAt,
  type PassthroughUsageOptions,
  STREAM_IDLE_TIMEOUT_MS,
  ttftProperty,
  type UsageCompletion,
  usageProperty,
} from './shared';
import { finalizeUsage } from './usage-validation';

export function passthroughCapture(
  {
    response,
    protocol,
    providerId,
    modelId,
    requestedModelId,
    onResponseId,
    startedAt,
    observation,
    idleTimeoutMs,
  }: PassthroughUsageOptions,
  logger: ServerLogSink | undefined,
): Captured<Response> {
  if (response.status < 200 || response.status >= 400) {
    return { value: response, completion: Promise.resolve({ outcome: 'failure', statusCode: response.status }) };
  }
  if (response.body === null) {
    return { value: response, completion: Promise.resolve({ outcome: 'success', statusCode: response.status }) };
  }

  const statusCode = response.status;
  const terminal = deferred<UsageCompletion>();
  const reader = response.body.getReader();
  const isSse = response.headers.get('content-type')?.toLowerCase().includes('text/event-stream') === true;
  let firstTokenAt: number | undefined;
  let completed = false;
  const idle = createIdleTimer(idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS, () => {
    if (completed) return;
    completed = true;
    terminal.resolve({
      outcome: 'failure',
      statusCode,
      errorCode: 'stream_idle_timeout',
      ...ttftProperty(startedAt, firstTokenAt),
    });
    void reader.cancel(new Error('stream_idle_timeout')).catch(() => {});
    releaseReader();
  });
  let committed = false;
  // Commit the session response only once the client has drained the stream to
  // EOF. A terminal frame observed mid-stream resolves usage/timing early (for
  // accurate trace duration), but a client that cancels before EOF must not
  // commit — so commit is an EOF-only side effect, separate from trace resolve.
  const commit = (obs: PassthroughObservation): void => {
    if (committed || obs.failed === true || obs.responseId === undefined) return;
    committed = true;
    onResponseId?.(obs.responseId);
  };
  const complete = async (obs: PassthroughObservation): Promise<void> => {
    if (completed) return;
    completed = true;
    idle.clear();
    if (obs.failed === true) {
      terminal.resolve({ outcome: 'failure', statusCode, ...ttftProperty(startedAt, firstTokenAt) });
      return;
    }
    const usage = await finalizePassthroughUsage(obs, { providerId, modelId, protocol, requestedModelId, logger });
    terminal.resolve({
      outcome: 'success',
      statusCode,
      ...usageProperty(usage),
      ...ttftProperty(startedAt, firstTokenAt),
    });
  };
  const sseObserver = isSse
    ? createSseUsageObserver(protocol, observation, {
        onContent: (contentAt) => (firstTokenAt ??= contentAt),
        onTerminal: (obs) => void complete(obs),
      })
    : undefined;
  const decoder = isSse ? new TextDecoder() : undefined;
  const jsonCapture = isSse ? undefined : createJsonCapture();
  let released = false;
  const releaseReader = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const returnedBody = createTeeBody({
    reader,
    idle,
    releaseReader,
    onChunk: (chunk) => {
      if (sseObserver !== undefined && decoder !== undefined) sseObserver.feed(decoder.decode(chunk, { stream: true }));
      else jsonCapture?.push(chunk);
    },
    onEnd: async () => {
      const finalObservation =
        sseObserver !== undefined && decoder !== undefined
          ? finishSseObservation(sseObserver, decoder)
          : jsonCapture !== undefined && jsonCapture.captured()
            ? extractPassthroughObservation(protocol, jsonCapture.text())
            : {};
      commit(finalObservation);
      await complete(finalObservation);
    },
    onError: (error) => {
      idle.clear();
      terminal.resolve({
        outcome: isAbortError(error) ? 'cancelled' : 'failure',
        statusCode,
        ...ttftProperty(startedAt, firstTokenAt),
      });
    },
    onCancel: () => {
      idle.clear();
      terminal.resolve({ outcome: 'cancelled', statusCode, ...ttftProperty(startedAt, firstTokenAt) });
    },
  });

  idle.arm();

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
  readonly onChunk: (chunk: Uint8Array) => void;
  readonly onEnd: () => Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly onCancel: () => void;
};

// Tees the upstream body to the client while feeding observation hooks. Chunk
// forwarding is byte-identical; onEnd/onError/onCancel drive completion. Idle
// re-arming happens per chunk so a stalled upstream is caught by the caller's timer.
function createTeeBody(deps: TeeBodyDeps): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let done = false;
      try {
        const next = await deps.reader.read();
        if (!next.done) {
          deps.onChunk(next.value);
          controller.enqueue(next.value);
          deps.idle.arm();
          return;
        }
        done = true;
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

function finishSseObservation(observer: PassthroughSseUsageObserver, decoder: TextDecoder): PassthroughObservation {
  observer.feed(decoder.decode());
  return observer.finish();
}

type PassthroughUsageContext = {
  readonly providerId: string;
  readonly modelId: string;
  readonly protocol: PassthroughUsageOptions['protocol'];
  readonly requestedModelId: string | undefined;
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
    ...(ctx.requestedModelId === undefined ? {} : { requestedModelId: ctx.requestedModelId }),
    ...(ctx.logger === undefined ? {} : { logger: ctx.logger }),
    ...(obs.issues === undefined ? {} : { issues: obs.issues }),
  });
}

function createSseUsageObserver(
  protocol: PassthroughUsageOptions['protocol'],
  observation: PassthroughUsageOptions['observation'],
  callbacks: {
    readonly onContent: (at: number) => void;
    readonly onTerminal: (observation: PassthroughObservation) => void;
  },
): PassthroughSseUsageObserver {
  const onEvent = observation?.observeSseEvent;
  return createPassthroughSseUsageObserver(protocol, {
    ...(onEvent === undefined ? {} : { onEvent }),
    onContent: () => callbacks.onContent(observeContentAt(observation)),
    onTerminal: callbacks.onTerminal,
  });
}

type JsonCapture = {
  // Accumulate a body chunk while under the size cap; once exceeded, capture is
  // permanently disabled and buffered bytes are dropped to bound memory.
  readonly push: (chunk: Uint8Array) => void;
  // Whether the full body is still buffered (never exceeded the cap).
  readonly captured: () => boolean;
  // Decoded UTF-8 text of the buffered body; empty once capture is disabled.
  readonly text: () => string;
};

function createJsonCapture(): JsonCapture {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let active = true;
  return {
    captured: () => active,
    push: (chunk) => {
      if (!active) return;
      const nextByteLength = byteLength + chunk.byteLength;
      if (nextByteLength > MAX_PASSTHROUGH_JSON_BYTES) {
        chunks.length = 0;
        byteLength = 0;
        active = false;
        return;
      }
      chunks.push(chunk);
      byteLength = nextByteLength;
    },
    text: () => {
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(bytes);
    },
  };
}
