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

export function createObservedFetch(fetcher: typeof globalThis.fetch): typeof globalThis.fetch {
  return (async (input, init) => {
    const scope = currentDebugRequestLogScope();
    if (scope?.attemptIndex === undefined || scope.providerId === undefined || scope.modelId === undefined) {
      return fetcher(input, init);
    }
    const identity = {
      requestId: scope.requestId,
      attemptIndex: scope.attemptIndex,
      providerId: scope.providerId,
      modelId: scope.modelId,
    } as const;
    const startedAt = performance.now();
    try {
      const request = new Request(input, init);
      logServerEvent(scope.logger, { event: 'request.upstream_snapshot', ...identity, ...requestMetadata(request) });
      const delegated = requestWithObservedBody(request, { ...identity, direction: 'upstream_request' }, scope.logger);
      const decompress = (init as BunFetchInit | undefined)?.decompress;
      const response = await fetcher(delegated, decompress === undefined ? undefined : { decompress });
      logServerEvent(scope.logger, {
        event: 'request.upstream_result',
        ...identity,
        durationMs: performance.now() - startedAt,
        outcome: 'response',
        ...responseMetadata(response),
      });
      return responseWithObservedBody(response, { ...identity, direction: 'upstream_response' }, scope.logger);
    } catch (error) {
      logServerEvent(scope.logger, {
        event: 'request.upstream_result',
        ...identity,
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
  identity: BodyIdentity,
  logger: ServerLogSink,
): ReadableStream<Uint8Array> {
  let sequence = 0;
  return tapTextBody(body, contentType, {
    chunk(text) {
      logServerEvent(logger, { event: 'request.body_chunk', ...identity, sequence: sequence++, text });
    },
    terminal({ byteLength, error, outcome }) {
      logServerEvent(logger, {
        event: 'request.body_terminal',
        ...identity,
        sequence,
        byteLength,
        outcome,
        ...(error === undefined ? {} : { errorType: serverErrorType(error) }),
      });
    },
  });
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
    return new Request(request.url, { ...init, body: observedBody(body, contentType, identity, logger) });
  } catch {
    return request;
  }
}

function responseWithObservedBody(response: Response, identity: BodyIdentity, logger: ServerLogSink): Response {
  let source: ReadableStream<Uint8Array>;
  let contentType: string | null;
  let metadata: ResponseMetadata;
  try {
    const body = response.body;
    if (body === null) return response;
    source = body;
    contentType = response.headers.get('content-type');
    metadata = {
      headers: response.headers,
      status: response.status,
      statusText: response.statusText,
      redirected: response.redirected,
      type: response.type,
      url: response.url,
    };
  } catch {
    return response;
  }
  return responseWithBody(response, observedBody(source, contentType, identity, logger), metadata);
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
