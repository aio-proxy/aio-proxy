import { createParser } from 'eventsource-parser';

import type { ResponseBodyObservation } from '../../response-observation';
import type { RequestBodyDirection, ServerLogSink } from '../../server-log';
import { logServerEvent, serverErrorType } from '../../server-log';
import { tapTextBody } from '../body-tap';
import type { BodyCaptureReason } from '../context';

export type BodyIdentity = {
  readonly requestId: string;
  readonly direction: RequestBodyDirection;
  readonly attemptIndex?: number;
  readonly sendIndex?: number;
  readonly providerId?: string;
  readonly modelId?: string;
};

type DebugResponseObservation = {
  readonly identity: BodyIdentity;
  readonly logger: ServerLogSink;
  readonly signal: AbortSignal | undefined;
  readonly omissionReason?: BodyCaptureReason;
  readonly captureMaxBytes?: number;
};

export type ResponseObservationOptions = {
  readonly bodyObservation?: ResponseBodyObservation;
  readonly observeSseEvent?: () => void;
  readonly debug?: DebugResponseObservation;
  readonly controlledIdentitySse?: boolean;
  readonly bodyTerminal?: (outcome: 'complete' | 'cancelled' | 'error', error?: unknown) => void;
};

export function observedBody(
  body: ReadableStream<Uint8Array>,
  contentType: string | null,
  options: ResponseObservationOptions,
): ReadableStream<Uint8Array> {
  const { bodyObservation, debug, observeSseEvent } = options;
  let sequence = 0;
  let pendingRead: number | undefined;
  let pendingSseEvents = 0;
  let readObservationActive = true;
  let parserActive = observeSseEvent !== undefined && options.controlledIdentitySse === true;
  const parser = parserActive
    ? createParser({
        onEvent() {
          if (!parserActive) return;
          pendingSseEvents++;
          try {
            observeSseEvent?.();
          } catch {
            parserActive = false;
          }
        },
      })
    : undefined;
  const observeRead = (byteLength: number, sseFrames: number) => {
    if (!readObservationActive || bodyObservation === undefined) return;
    try {
      bodyObservation.observeRead(byteLength, sseFrames);
    } catch {
      readObservationActive = false;
    }
  };
  return tapTextBody(
    body,
    contentType,
    {
      chunk(text) {
        if (debug !== undefined && debug.omissionReason === undefined) {
          logServerEvent(debug.logger, { event: 'request.body_chunk', ...debug.identity, sequence: sequence++, text });
        }
      },
      text: parserActive
        ? (text) => {
            if (!parserActive || parser === undefined) return;
            try {
              parser.feed(text);
            } catch {
              parserActive = false;
            }
          }
        : undefined,
      terminal({ byteLength, error, outcome, truncated, captureLimitBytes }) {
        safely(() => options.bodyTerminal?.(outcome, error));
        if (debug !== undefined) {
          logServerEvent(debug.logger, {
            event: 'request.body_terminal',
            ...debug.identity,
            sequence,
            byteLength,
            outcome,
            ...(captureLimitBytes === undefined ? {} : { captureLimitBytes }),
            ...(truncated ? { truncated: true } : {}),
            ...(debug.omissionReason !== undefined
              ? { omitted: true, omissionReason: debug.omissionReason }
              : debug.captureMaxBytes === 0
                ? { omitted: true, omissionReason: 'capture_limit' as const }
                : {}),
            ...(error === undefined ? {} : { errorType: serverErrorType(error) }),
          });
        }
      },
      sourceRead(byteLength) {
        observeRead(byteLength, 0);
        if (parser !== undefined) {
          pendingRead = byteLength;
          pendingSseEvents = 0;
        }
      },
      sseFrames() {
        if (pendingRead === undefined) return;
        observeRead(pendingRead, pendingSseEvents);
        pendingRead = undefined;
      },
    },
    debug?.signal,
    debug?.omissionReason === undefined ? (debug?.captureMaxBytes ?? 67108864) : 0,
  );
}

function safely<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}
