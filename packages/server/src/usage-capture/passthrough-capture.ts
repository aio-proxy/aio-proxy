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
  deferred,
  MAX_PASSTHROUGH_JSON_BYTES,
  observeContentAt,
  type PassthroughUsageOptions,
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
  const complete = async (obs: PassthroughObservation): Promise<void> => {
    if (completed) return;
    completed = true;
    if (obs.failed === true) {
      terminal.resolve({ outcome: 'failure', statusCode, ...ttftProperty(startedAt, firstTokenAt) });
      return;
    }
    const usage = await finalizeUsage({
      usage: obs.usage === undefined && obs.issues === undefined ? undefined : { ...obs.usage, providerId, modelId },
      accounting: { source: 'passthrough', protocol },
      ...(requestedModelId === undefined ? {} : { requestedModelId }),
      ...(logger === undefined ? {} : { logger }),
      ...(obs.issues === undefined ? {} : { issues: obs.issues }),
    });
    if (obs.responseId !== undefined) onResponseId?.(obs.responseId);
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
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let captureJson = !isSse;
  let released = false;
  const releaseReader = () => {
    if (released) return;
    released = true;
    reader.releaseLock();
  };
  const returnedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let done = false;
      try {
        const next = await reader.read();
        if (!next.done) {
          if (sseObserver !== undefined && decoder !== undefined) {
            sseObserver.feed(decoder.decode(next.value, { stream: true }));
          } else if (captureJson) {
            const nextByteLength = byteLength + next.value.byteLength;
            if (nextByteLength <= MAX_PASSTHROUGH_JSON_BYTES) {
              chunks.push(next.value);
              byteLength = nextByteLength;
            } else {
              chunks.length = 0;
              byteLength = 0;
              captureJson = false;
            }
          }
          controller.enqueue(next.value);
          return;
        }

        done = true;
        controller.close();
        const finalObservation =
          sseObserver !== undefined && decoder !== undefined
            ? finishSseObservation(sseObserver, decoder)
            : captureJson
              ? extractPassthroughObservation(protocol, decodeChunks(chunks, byteLength))
              : {};
        await complete(finalObservation);
      } catch (error) {
        done = true;
        terminal.resolve({
          outcome: isAbortError(error) ? 'cancelled' : 'failure',
          statusCode,
          ...ttftProperty(startedAt, firstTokenAt),
        });
        controller.error(error);
      } finally {
        if (done) releaseReader();
      }
    },
    async cancel(reason) {
      terminal.resolve({ outcome: 'cancelled', statusCode, ...ttftProperty(startedAt, firstTokenAt) });
      try {
        await reader.cancel(reason);
      } finally {
        releaseReader();
      }
    },
  });

  return {
    value: new Response(returnedBody, {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
    }),
    completion: terminal.promise,
  };
}

function finishSseObservation(observer: PassthroughSseUsageObserver, decoder: TextDecoder): PassthroughObservation {
  observer.feed(decoder.decode());
  return observer.finish();
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

function decodeChunks(chunks: readonly Uint8Array[], byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
