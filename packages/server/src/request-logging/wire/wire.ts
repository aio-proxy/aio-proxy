import { ProviderProtocol } from '@aio-proxy/types';

import type { AttemptResponseObservation, SendResponseObservation } from '../../response-observation';
import { currentAttemptResponseObservation, inheritObservedResponse } from '../../response-observation';
import type { ServerLogSink } from '../../server-log';
import { logServerEvent, serverErrorDetails } from '../../server-log';
import { type BodyCaptureReason, currentDebugRequestLogScope } from '../context';
import { requestMetadata, responseMetadata } from '../request-metadata';
import { observedBody, type BodyIdentity, type ResponseObservationOptions } from './body-observation';
import { type BunFetchInit, fetchTarget, fetchWithSpan } from './upstream-span';

function takeSendIndex(scope: { readonly attemptIndex?: number; readonly sendCounts?: Map<number, number> }): number {
  const attempt = scope.attemptIndex;
  const bag = scope.sendCounts;
  if (attempt === undefined || bag === undefined) return 0;
  const index = bag.get(attempt) ?? 0;
  bag.set(attempt, index + 1);
  return index;
}

type ResponseMetadata = ResponseInit & {
  readonly redirected: boolean;
  readonly type: Response['type'];
  readonly url: string;
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
              sendIndex: takeSendIndex(scope),
              providerId: scope.providerId,
              modelId: scope.modelId,
            },
            logger: scope.logger,
          };
    if (debug === undefined && observation === undefined) {
      return fetchWithSpan(fetcher, input, init);
    }
    const send = safely(() => observation?.observeFetchStart(fetchTarget(input)?.endpoint));
    if (debug === undefined) {
      const response = await fetchWithSpan(fetcher, input, init, observation, send);
      const options = responseObservationOptions(response, init, observation, send);
      return options.bodyObservation === undefined ? response : responseWithObservedBody(response, options);
    }
    const startedAt = performance.now();
    try {
      const request = new Request(input, init);
      logServerEvent(debug.logger, {
        event: 'request.upstream_snapshot',
        ...debug.identity,
        ...requestMetadata(request),
      });
      const hideVideoBodies = scope?.capturePayload === false || scope?.sourceProtocol === ProviderProtocol.OpenAIVideo;
      const requestIdentity = { ...debug.identity, direction: 'upstream_request' as const };
      const omissionReason = hideVideoBodies ? (scope?.omissionReason ?? 'media_payload') : undefined;
      if (omissionReason !== undefined) logOmittedBody(debug.logger, requestIdentity, omissionReason);
      const delegated = hideVideoBodies
        ? request
        : requestWithObservedBody(request, requestIdentity, debug.logger, scope?.captureMaxBytes);
      const decompress = (init as BunFetchInit | undefined)?.decompress;
      const response = await fetchWithSpan(
        fetcher,
        delegated,
        decompress === undefined ? undefined : { decompress },
        observation,
        send,
      );
      logServerEvent(debug.logger, {
        event: 'request.upstream_result',
        ...debug.identity,
        durationMs: performance.now() - startedAt,
        outcome: 'response',
        ...responseMetadata(response),
      });
      // 视频正文故意不抓 chunk，但终态跟着客户端真正读完/失败/取消走：
      // 头到达时写 complete 会让 hop 提前变绿，消费失败也洗不掉。
      return responseWithObservedBody(response, {
        ...responseObservationOptions(response, init, observation, send),
        debug: {
          identity: { ...debug.identity, direction: 'upstream_response' },
          logger: debug.logger,
          signal: request.signal,
          captureMaxBytes: scope?.captureMaxBytes,
          ...(omissionReason === undefined ? {} : { omissionReason }),
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
  // Videos create 可能带 data URL / multipart。头照常记；正文不落 chunk，但要有终态，
  // 否则面板当没抓、hopsNeedNextDay 还会去扫下一天。
  if (scope.capturePayload === false || inboundProtocol === ProviderProtocol.OpenAIVideo) {
    logOmittedBody(
      scope.logger,
      { requestId: scope.requestId, direction: 'inbound' },
      scope.omissionReason ?? 'media_payload',
    );
    return request;
  }
  return requestWithObservedBody(
    request,
    { requestId: scope.requestId, direction: 'inbound' },
    scope.logger,
    scope.captureMaxBytes,
  );
}

function logOmittedBody(logger: ServerLogSink, identity: BodyIdentity, omissionReason: BodyCaptureReason): void {
  logServerEvent(logger, {
    event: 'request.body_terminal',
    ...identity,
    sequence: 0,
    outcome: 'complete',
    omitted: true,
    omissionReason,
  });
}

function requestWithObservedBody(
  request: Request,
  identity: BodyIdentity,
  logger: ServerLogSink,
  captureMaxBytes?: number,
): Request {
  try {
    const body = request.body;
    if (body === null) {
      // GET / HEAD：没有 body 可读。不记 complete 的话 hopsNeedNextDay 会把这次发送
      // 当成正文还没到，已结束的历史调用链每次打开都去啃下一天的 debug 日志。
      emitEmptyBodyTerminal({ identity, logger });
      return request;
    }
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
      body: observedBody(body, contentType, { debug: { identity, logger, signal: request.signal, captureMaxBytes } }),
    });
  } catch {
    return request;
  }
}

function emitEmptyBodyTerminal(
  debug: { readonly identity: BodyIdentity; readonly logger: ServerLogSink } | undefined,
): void {
  if (debug === undefined) return;
  logServerEvent(debug.logger, {
    event: 'request.body_terminal',
    ...debug.identity,
    sequence: 0,
    byteLength: 0,
    outcome: 'complete',
  });
}

function responseWithObservedBody(response: Response, options: ResponseObservationOptions): Response {
  let source: ReadableStream<Uint8Array>;
  let contentType: string | null;
  let contentEncoding: string | null;
  let metadata: ResponseMetadata;
  try {
    const body = response.body;
    if (body === null) {
      // 204 / HEAD：没有 body 可读，也就没有 tap 终态。不记一行 complete 的话
      // 抓包会把这次发送一直标成 running。
      emitEmptyBodyTerminal(options.debug);
      return response;
    }
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
        options.controlledIdentitySse === true &&
        options.bodyObservation !== undefined &&
        isSse(contentType) &&
        isIdentityEncoding(contentEncoding),
    }),
    metadata,
  );
}

function controlledStream(init: RequestInit | undefined): boolean {
  return (init as BunFetchInit | undefined)?.decompress === false;
}

function responseObservationOptions(
  response: Response,
  init: RequestInit | undefined,
  observation: AttemptResponseObservation | undefined,
  send: SendResponseObservation | void,
): ResponseObservationOptions {
  const controlled = controlledStream(init);
  const aggregate = safely(() => observation?.observeResponse(response, { controlledStream: controlled }));
  const individual = safely(() => send?.observeResponse(response, controlled));
  const bodyObservation =
    aggregate === undefined && individual === undefined
      ? undefined
      : {
          observeRead(byteLength: number, sseFrames: number) {
            safely(() => aggregate?.observeRead(byteLength, sseFrames));
            safely(() => individual?.observeRead(byteLength, sseFrames));
          },
        };
  return {
    ...(bodyObservation === undefined ? {} : { bodyObservation }),
    controlledIdentitySse: controlled,
    ...(observation === undefined && send === undefined
      ? {}
      : {
          observeSseEvent() {
            safely(() => observation?.observeSseEvent());
            safely(() => send?.observeSseEvent());
          },
        }),
    ...(send === undefined ? {} : { bodyTerminal: send.endBody }),
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
    inheritObservedResponse(original, wrapped);
    return wrapped;
  } catch {
    return original;
  }
}
