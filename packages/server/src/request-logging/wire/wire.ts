import { createParser } from 'eventsource-parser';

import type { ResponseBodyObservation } from '../../response-observation';
import { currentAttemptResponseObservation } from '../../response-observation';
import type { RequestBodyDirection, ServerLogSink } from '../../server-log';
import { logServerEvent, serverErrorDetails, serverErrorType } from '../../server-log';
import { tapTextBody } from '../body-tap';
import { currentDebugRequestLogScope } from '../context';
import { requestMetadata, responseMetadata } from '../request-metadata';

type BunFetchInit = RequestInit & { readonly decompress?: boolean };

type BodyIdentity = {
  readonly requestId: string;
  readonly direction: RequestBodyDirection;
  readonly attemptIndex?: number;
  readonly providerId?: string;
  readonly modelId?: string;
};

type ResponseMetadata = ResponseInit & {
  readonly redirected: boolean;
  readonly type: Response['type'];
  readonly url: string;
};

type DebugResponseObservation = {
  readonly identity: BodyIdentity;
  readonly logger: ServerLogSink;
  readonly signal: AbortSignal | undefined;
};

type ResponseObservationOptions = {
  readonly bodyObservation?: ResponseBodyObservation;
  readonly observeSseEvent?: () => void;
  readonly debug?: DebugResponseObservation;
  readonly controlledIdentitySse?: boolean;
};

export function createObservedFetch(fetcher: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input, init) => {
    const scope = currentDebugRequestLogScope();
    const observation = currentAttemptResponseObservation();
    const debug =
      scope?.attemptIndex === undefined || scope.providerId === undefined || scope.modelId === undefined
        ? undefined
        : {
            identity: {
              requestId: scope.requestId,
              attemptIndex: scope.attemptIndex,
              providerId: scope.providerId,
              modelId: scope.modelId,
            },
            logger: scope.logger,
          };
    if (debug === undefined && observation === undefined) {
      return fetcher(input, init);
    }
    safely(() => observation?.observeFetchStart());
    if (debug === undefined) {
      const response = await fetcher(input, init);
      const bodyObservation = safely(() =>
        observation?.observeResponse(response, { controlledStream: controlledStream(init) }),
      );
      return bodyObservation === undefined
        ? response
        : responseWithObservedBody(response, responseObservationOptions(bodyObservation, observation?.observeSseEvent));
    }
    const startedAt = performance.now();
    try {
      const request = new Request(input, init);
      logServerEvent(debug.logger, {
        event: 'request.upstream_snapshot',
        ...debug.identity,
        ...requestMetadata(request),
      });
      const delegated = requestWithObservedBody(
        request,
        { ...debug.identity, direction: 'upstream_request' },
        debug.logger,
      );
      const decompress = (init as BunFetchInit | undefined)?.decompress;
      const response = await fetcher(delegated, decompress === undefined ? undefined : { decompress });
      const bodyObservation = safely(() =>
        observation?.observeResponse(response, { controlledStream: controlledStream(init) }),
      );
      logServerEvent(debug.logger, {
        event: 'request.upstream_result',
        ...debug.identity,
        durationMs: performance.now() - startedAt,
        outcome: 'response',
        ...responseMetadata(response),
      });
      return responseWithObservedBody(response, {
        ...responseObservationOptions(bodyObservation, observation?.observeSseEvent),
        debug: {
          identity: { ...debug.identity, direction: 'upstream_response' },
          logger: debug.logger,
          signal: request.signal,
        },
      });
    } catch (error) {
      logServerEvent(debug.logger, {
        event: 'request.upstream_result',
        ...debug.identity,
        durationMs: performance.now() - startedAt,
        outcome: 'exception',
        ...serverErrorDetails(error),
      });
      throw error;
    }
  }) as typeof globalThis.fetch;
}

export function observeInboundRequest(request: Request, inboundProtocol: string): Request {
  const scope = currentDebugRequestLogScope();
  if (scope === undefined) return request;
  logServerEvent(scope.logger, {
    event: 'request.inbound_snapshot',
    requestId: scope.requestId,
    inboundProtocol,
    ...requestMetadata(request),
  });
  return requestWithObservedBody(request, { requestId: scope.requestId, direction: 'inbound' }, scope.logger);
}

function observedBody(
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
        onError() {
          parserActive = false;
        },
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
        if (debug !== undefined) {
          logServerEvent(debug.logger, { event: 'request.body_chunk', ...debug.identity, sequence: sequence++, text });
        }
        if (!parserActive || parser === undefined) return;
        try {
          parser.feed(text);
        } catch {
          parserActive = false;
        }
      },
      terminal({ byteLength, error, outcome }) {
        if (debug !== undefined) {
          logServerEvent(debug.logger, {
            event: 'request.body_terminal',
            ...debug.identity,
            sequence,
            byteLength,
            outcome,
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
  );
}

function requestWithObservedBody(request: Request, identity: BodyIdentity, logger: ServerLogSink): Request {
  try {
    const body = request.body;
    if (body === null) return request;
    const contentType = request.headers.get('content-type');
    const init: RequestInit = {
      cache: request.cache,
      credentials: request.credentials,
      headers: request.headers,
      integrity: request.integrity,
      keepalive: request.keepalive,
      method: request.method,
      mode: request.mode,
      redirect: request.redirect,
      referrer: request.referrer,
      referrerPolicy: request.referrerPolicy,
      signal: request.signal,
    };
    return new Request(request.url, {
      ...init,
      body: observedBody(body, contentType, { debug: { identity, logger, signal: request.signal } }),
    });
  } catch {
    return request;
  }
}

function responseWithObservedBody(response: Response, options: ResponseObservationOptions): Response {
  let source: ReadableStream<Uint8Array>;
  let contentType: string | null;
  let contentEncoding: string | null;
  let metadata: ResponseMetadata;
  try {
    const body = response.body;
    if (body === null) return response;
    source = body;
    const headers = response.headers;
    contentType = headers.get('content-type');
    contentEncoding = headers.get('content-encoding');
    metadata = {
      headers,
      status: response.status,
      statusText: response.statusText,
      redirected: response.redirected,
      type: response.type,
      url: response.url,
    };
  } catch {
    return response;
  }
  return responseWithBody(
    response,
    observedBody(source, contentType, {
      ...options,
      controlledIdentitySse:
        options.bodyObservation !== undefined && isSse(contentType) && isIdentityEncoding(contentEncoding),
    }),
    metadata,
  );
}

function controlledStream(init: RequestInit | undefined): boolean {
  return (init as BunFetchInit | undefined)?.decompress === false;
}

function responseObservationOptions(
  bodyObservation: ResponseBodyObservation | undefined,
  observeSseEvent: (() => void) | undefined,
): ResponseObservationOptions {
  return {
    ...(bodyObservation === undefined ? {} : { bodyObservation }),
    ...(observeSseEvent === undefined ? {} : { observeSseEvent }),
  };
}

function safely<T>(operation: () => T): T | undefined {
  try {
    return operation();
  } catch {
    return undefined;
  }
}

function isSse(contentType: string | null): boolean {
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream';
}

function isIdentityEncoding(value: string | null): boolean {
  const encodings = (value ?? '')
    .split(',')
    .map((encoding) => encoding.trim().toLowerCase())
    .filter(Boolean);
  return encodings.length === 0 || (encodings.length === 1 && encodings[0] === 'identity');
}

function responseWithBody(original: Response, body: ReadableStream<Uint8Array>, metadata: ResponseMetadata): Response {
  try {
    const wrapped = new Response(body, metadata);
    Object.defineProperties(wrapped, {
      redirected: { configurable: true, value: metadata.redirected },
      type: { configurable: true, value: metadata.type },
      url: { configurable: true, value: metadata.url },
    });
    return wrapped;
  } catch {
    return original;
  }
}
