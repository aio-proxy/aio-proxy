import {
  type AnyProtocolAdapter,
  type ImageProtocolAdapter,
  RequestBodyTooLargeError,
  releaseMultipartSpool,
  RouterModelNotFoundError,
  UnsupportedContentEncodingError,
} from '@aio-proxy/core';
import type { ProviderProtocol } from '@aio-proxy/types';
import { context } from '@opentelemetry/api';

import { observeInboundRequest, withRequestLogContext } from '../../request-logging';
import { requestAsksFastMode, type RequestTraceSession } from '../../request-tracing';
import { isInboundAbort } from '../../route-observation';
import type { ProviderRouteSource } from '../../runtime';
import { attemptCandidates } from './attempt';
import { filterCandidatesByCapability } from './attempt/capability-filter';
import { logRequestDiagnostics, logRequestFailed, logRequestRejected } from './logging';
import { cancelRetainedRequestBody, hasInvalidOrOversizedContentLength } from './request';

export type HandleProtocolRequestOptions<TRequest, TContext> = {
  readonly adapter: AnyProtocolAdapter<TRequest, TContext> | ImageProtocolAdapter<TRequest, TContext>;
  readonly context: TContext;
  readonly rawRequest: Request;
  readonly source: ProviderRouteSource;
};

export async function handleProtocolRequest<TRequest, TContext>(
  options: HandleProtocolRequestOptions<TRequest, TContext>,
): Promise<Response> {
  const inboundProtocol = options.adapter.protocol;
  const session = options.source.requestRecorder.begin({
    inboundRequest: options.rawRequest,
    inboundProtocol,
  });
  return await context.with(session.rootContext, () =>
    withRequestLogContext(
      {
        requestId: session.requestId,
        debug: options.source.debugLogging === true,
        logger: options.source.logger,
      },
      () => handleProtocolRequestInContext(options, session, inboundProtocol),
    ),
  );
}

async function handleProtocolRequestInContext<TRequest, TContext>(
  options: HandleProtocolRequestOptions<TRequest, TContext>,
  session: RequestTraceSession,
  inboundProtocol: ProviderProtocol,
): Promise<Response> {
  const { adapter, context, source } = options;
  let { rawRequest } = options;
  let requestedModelId: string | undefined;
  let releaseRetainedBody = false;
  try {
    try {
      rawRequest = observeInboundRequest(rawRequest, inboundProtocol);
    } catch (error) {
      await cancelRetainedRequestBody(rawRequest, error);
      throw error;
    }
    const limits = adapter.bodyLimits(rawRequest, context);
    if (hasInvalidOrOversizedContentLength(rawRequest, limits)) {
      const error = new RequestBodyTooLargeError('Request body too large');
      await cancelRetainedRequestBody(rawRequest, error);
      return rejectRequest({
        source,
        session,
        rawRequest,
        inboundProtocol,
        response: adapter.errors.tooLarge(),
        errorCode: 'request_too_large',
        error,
      });
    }

    const parsed = await parseProtocolRequest({ adapter, context, inboundProtocol, rawRequest, session, source });
    if (parsed.response !== undefined) return parsed.response;
    const request = parsed.request;
    releaseRetainedBody = true;

    const requestedModel = adapter.model(request, context);
    const streamRequested = adapter.wantsStream(request, context);
    requestedModelId = requestedModel;
    const resolution = source.logicalSessionStore.begin({
      requestedModelId: requestedModel,
      requestId: session.requestId,
      hints: adapter.session?.(request, context) ?? { candidates: [], transcript: request },
      headers: rawRequest.headers,
    });
    session.identify({
      requestedModelId: requestedModel,
      resolution,
      mutateSessionState: true,
      streamRequested,
      ...(requestAsksFastMode(request, rawRequest.headers) ? { fastRequested: true } : {}),
    });
    if (resolution.responseStatus === 'ambiguous') {
      const error = new Error('Ambiguous previous response ownership');
      return rejectRequest({
        source,
        session,
        rawRequest,
        inboundProtocol,
        requestedModelId: requestedModel,
        response: adapter.errors.previousResponseConflict(),
        errorCode: 'previous_response_conflict',
        error,
      });
    }
    logRequestDiagnostics({
      source,
      requestId: session.requestId,
      rawRequest,
      inboundProtocol,
      requestedModelId: requestedModel,
      diagnostics: adapter.requestDiagnostics(request, context),
    });
    return await attemptResolvedRequest({
      adapter,
      context,
      inboundProtocol,
      rawRequest,
      request,
      requestedModel,
      resolution,
      session,
      source,
      streamRequested,
    });
  } catch (error) {
    const cancelled = isInboundAbort(error, rawRequest.signal);
    if (
      session.finish(cancelled ? { outcome: 'cancelled' } : { outcome: 'failure', errorCode: 'internal_error' }) &&
      !cancelled
    ) {
      logRequestFailed({
        source,
        requestId: session.requestId,
        rawRequest,
        inboundProtocol,
        ...(requestedModelId === undefined ? {} : { requestedModelId }),
        error,
      });
    }
    throw error;
  } finally {
    if (releaseRetainedBody) {
      void cancelRetainedRequestBody(rawRequest, 'request body no longer needed');
      void releaseMultipartSpool(rawRequest);
    }
  }
}

type ParsedProtocolRequest<TRequest> =
  | { readonly request: TRequest; readonly response?: undefined }
  | { readonly request?: undefined; readonly response: Response };

async function parseProtocolRequest<TRequest, TContext>(options: {
  readonly adapter: AnyProtocolAdapter<TRequest, TContext> | ImageProtocolAdapter<TRequest, TContext>;
  readonly context: TContext;
  readonly inboundProtocol: ProviderProtocol;
  readonly rawRequest: Request;
  readonly session: RequestTraceSession;
  readonly source: ProviderRouteSource;
}): Promise<ParsedProtocolRequest<TRequest>> {
  const { adapter, context, rawRequest } = options;
  try {
    return { request: await adapter.parse(rawRequest, context) };
  } catch (error) {
    await cancelRetainedRequestBody(rawRequest, error);
    if (error instanceof RequestBodyTooLargeError) {
      return rejectParsedRequest(adapter.errors.tooLarge(), 'request_too_large', error, options);
    }
    if (error instanceof UnsupportedContentEncodingError) {
      return rejectParsedRequest(
        adapter.errors.unsupportedContentEncoding(),
        'unsupported_content_encoding',
        error,
        options,
      );
    }
    const response = adapter.errors.requestError(error);
    if (response === undefined) throw error;
    return rejectParsedRequest(
      response,
      response.status === 501 ? 'unsupported_feature' : 'invalid_request',
      error,
      options,
    );
  }
}

function rejectParsedRequest<TRequest, TContext>(
  response: Response,
  errorCode: string,
  error: unknown,
  {
    inboundProtocol,
    rawRequest,
    session,
    source,
  }: {
    readonly adapter: AnyProtocolAdapter<TRequest, TContext> | ImageProtocolAdapter<TRequest, TContext>;
    readonly context: TContext;
    readonly inboundProtocol: ProviderProtocol;
    readonly rawRequest: Request;
    readonly session: RequestTraceSession;
    readonly source: ProviderRouteSource;
  },
): ParsedProtocolRequest<TRequest> {
  return { response: rejectRequest({ source, session, rawRequest, inboundProtocol, response, errorCode, error }) };
}

async function attemptResolvedRequest<TRequest, TContext>(options: {
  readonly adapter: AnyProtocolAdapter<TRequest, TContext> | ImageProtocolAdapter<TRequest, TContext>;
  readonly context: TContext;
  readonly inboundProtocol: ProviderProtocol;
  readonly rawRequest: Request;
  readonly request: TRequest;
  readonly requestedModel: string;
  readonly resolution: ReturnType<ProviderRouteSource['logicalSessionStore']['begin']>;
  readonly session: RequestTraceSession;
  readonly source: ProviderRouteSource;
  readonly streamRequested: boolean;
}): Promise<Response> {
  const {
    adapter,
    context,
    inboundProtocol,
    rawRequest,
    request,
    requestedModel,
    resolution,
    session,
    source,
    streamRequested,
  } = options;
  const lease = source.acquireProviderSnapshot();
  let deferred = false;
  const deferRelease = () => {
    deferred = true;
  };
  try {
    const candidates = lease.snapshot.router.resolve(requestedModel, adapter.dimensions(request, context), {
      session: resolution.context.session,
    });
    const eligible = filterCandidatesByCapability(candidates, adapter.capability, {
      requestedModelId: requestedModel,
      routerModels: lease.snapshot.config?.router.models,
    });
    if (eligible.length === 0) {
      const error = new Error('No eligible provider candidates for inbound capability');
      return rejectRequest({
        source,
        session,
        rawRequest,
        inboundProtocol,
        requestedModelId: requestedModel,
        response: adapter.errors.unsupported(adapter.capability === 'image' ? 'images' : 'transform_dispatch'),
        errorCode: 'not_implemented',
        error,
      });
    }
    return await attemptCandidates({
      adapter,
      candidates: eligible,
      config: lease.snapshot.config,
      context,
      deferRelease,
      rawRequest,
      release: lease.release,
      request,
      requestedModelId: requestedModel,
      resolution,
      session,
      source,
      streamRequested,
    });
  } catch (error) {
    if (!(error instanceof RouterModelNotFoundError)) throw error;
    return rejectRequest({
      source,
      session,
      rawRequest,
      inboundProtocol,
      requestedModelId: requestedModel,
      response: adapter.errors.modelNotFound(error.message),
      errorCode: 'model_not_found',
      error,
    });
  } finally {
    if (!deferred) lease.release();
  }
}

function rejectRequest(options: {
  readonly source: ProviderRouteSource;
  readonly session: RequestTraceSession;
  readonly rawRequest: Request;
  readonly inboundProtocol: string;
  readonly requestedModelId?: string;
  readonly response: Response;
  readonly errorCode: string;
  readonly error: unknown;
}): Response {
  const { response, session, ...rejection } = options;
  session.finish({
    outcome: 'failure',
    finalHttpStatus: response.status,
    errorCode: rejection.errorCode,
    clientResponse: response,
  });
  logRequestRejected({ ...rejection, requestId: session.requestId, statusCode: response.status });
  return response;
}

export { resolveSupportedEfforts, resolveSupportedEffortsForDimensions } from './attempt/effort-capability';
export { hasInvalidOrOversizedContentLength } from './request';
