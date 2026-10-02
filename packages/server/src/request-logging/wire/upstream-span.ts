import { type Attributes, context, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

import { attributeName, getTraceRuntime } from '../../request-tracing';
import type {
  AttemptResponseEndpoint,
  AttemptResponseObservation,
  SendResponseObservation,
} from '../../response-observation';
import { serverErrorType } from '../../server-log';
import { capturesRequestPayload, currentRequestLogContext, currentUpstreamUrlTemplate } from '../context';

export type BunFetchInit = RequestInit & { readonly decompress?: boolean };

// The HTTP send is parented explicitly to its candidate, even if a provider
// establishes another active span inside the invocation.
export async function fetchWithSpan(
  fetcher: typeof globalThis.fetch,
  input: Parameters<typeof globalThis.fetch>[0],
  init?: BunFetchInit,
  observation?: AttemptResponseObservation,
  send?: SendResponseObservation | void,
): Promise<Response> {
  const parent = observation?.parentContext ?? context.active();
  if (trace.getSpan(parent) === undefined) {
    try {
      return await fetcher(input, init);
    } catch (error) {
      send?.fail(error);
      throw error;
    }
  }
  const request = typeof input === 'object' && 'url' in input ? input : undefined;
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  const urlTemplate = currentUpstreamUrlTemplate();
  const startedAt = send?.startedAt ?? performance.now();
  const capturePayload = capturesRequestPayload();
  const attemptIndex = currentRequestLogContext()?.attemptIndex;
  const span = getTraceRuntime().tracer.startSpan(
    urlTemplate === undefined ? method : `${method} ${urlTemplate}`,
    {
      kind: SpanKind.CLIENT,
      startTime: performance.timeOrigin + startedAt,
      attributes: {
        [attributeName.httpRequestMethod]: method,
        ...(urlTemplate === undefined ? {} : { [attributeName.urlTemplate]: urlTemplate }),
        ...(send === undefined ? {} : { [attributeName.upstreamSendIndex]: send.index }),
        ...(send === undefined || attemptIndex === undefined
          ? {}
          : { [attributeName.upstreamCandidateIndex]: attemptIndex }),
        ...targetAttributes(request?.url ?? String(input)),
      },
    },
    parent,
  );
  send?.onFinish((snapshot) => {
    const attributes: Attributes = {
      ...(snapshot.transportObservation === undefined
        ? {}
        : { [attributeName.transportObservation]: snapshot.transportObservation }),
      ...(snapshot.upstreamHeadersMs === undefined
        ? {}
        : { [attributeName.upstreamHeadersMs]: snapshot.upstreamHeadersMs }),
      ...(snapshot.firstUpstreamByteMs === undefined
        ? {}
        : { [attributeName.firstUpstreamByteMs]: snapshot.firstUpstreamByteMs }),
      ...(snapshot.firstSseEventMs === undefined ? {} : { [attributeName.firstSseEventMs]: snapshot.firstSseEventMs }),
      ...(snapshot.maxSseFramesPerRead === undefined
        ? {}
        : { [attributeName.maxSseFramesPerRead]: snapshot.maxSseFramesPerRead }),
      ...(!capturePayload || snapshot.contentEncoding === undefined
        ? {}
        : { [attributeName.contentEncoding]: snapshot.contentEncoding }),
      ...(snapshot.bodyOutcome === undefined ? {} : { [attributeName.upstreamBodyOutcome]: snapshot.bodyOutcome }),
      ...(snapshot.retryReason === undefined ? {} : { [attributeName.upstreamRetryReason]: snapshot.retryReason }),
      ...(snapshot.responseSelected === undefined
        ? {}
        : { [attributeName.upstreamResponseSelected]: snapshot.responseSelected }),
    };
    span.setAttributes(attributes);
    if (snapshot.error !== undefined) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      if (capturePayload) span.setAttribute(attributeName.errorType, serverErrorType(snapshot.error));
    }
    if (snapshot.retryReason !== undefined) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end(snapshot.endedAt);
  });
  try {
    const response = await fetcher(input, init);
    span.setAttribute(attributeName.upstreamHeadersMs, Math.max(0, performance.now() - startedAt));
    span.setAttribute(attributeName.httpStatusCode, response.status);
    if (response.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
    return response;
  } catch (error) {
    send?.fail(error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    if (capturePayload) span.setAttribute(attributeName.errorType, serverErrorType(error));
    throw error;
  } finally {
    // Candidate-owned sends are flushed before the attempt/root buffer drains.
    // Other callers keep the existing response-header span boundary.
    if (send === undefined) span.end();
  }
}

function targetAttributes(href: string): Attributes {
  const target = fetchTarget(href);
  if (target === undefined) return {};
  const { endpoint, url } = target;
  url.username = '';
  url.password = '';
  for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, 'REDACTED');
  return {
    [attributeName.serverAddress]: endpoint.serverAddress,
    ...(endpoint.serverPort === undefined ? {} : { [attributeName.serverPort]: endpoint.serverPort }),
    [attributeName.urlFull]: url.toString(),
    [attributeName.urlPath]: url.pathname,
  };
}

export function fetchTarget(
  input: Parameters<typeof globalThis.fetch>[0] | string,
): { readonly endpoint: AttemptResponseEndpoint; readonly url: URL } | undefined {
  try {
    const href = typeof input === 'object' && 'url' in input ? input.url : String(input);
    const url = new URL(href);
    return {
      endpoint: {
        serverAddress: url.hostname.replace(/^\[|\]$/gu, ''),
        ...(url.port === '' ? {} : { serverPort: Number(url.port) }),
      },
      url,
    };
  } catch {
    return undefined;
  }
}
