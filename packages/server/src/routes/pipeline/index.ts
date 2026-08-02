import {
  type ProtocolAdapter,
  RequestBodyTooLargeError,
  RouterModelNotFoundError,
  UnsupportedContentEncodingError,
} from '@aio-proxy/core';
import type { ProviderProtocol } from '@aio-proxy/types';
import { context } from '@opentelemetry/api';

import { observeInboundRequest, withRequestLogContext } from '../../request-logging';
import type { RequestTraceSession } from '../../request-tracing';
import { isInboundAbort } from '../../route-observation';
import type { ProviderRouteSource } from '../../runtime';
import { attemptCandidates } from './attempt';
import { logRequestDiagnostics, logRequestFailed, logRequestRejected } from './logging';
import { cancelRetainedRequestBody, hasInvalidOrOversizedContentLength } from './request';

export type HandleProtocolRequestOptions<TRequest, TContext> = {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly context: TContext;
  readonly rawRequest: Request;
  readonly source: ProviderRouteSource;
};

export async function handleProtocolRequest<TRequest, TContext>(
  options: HandleProtocolRequestOptions<TRequest, TContext>,
): Promise<Response> {
  const inboundProtocol = options.adapter.protocol;
  const session = options.source.requestRecorder.begin({
    headers: options.rawRequest.headers,
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
    if (hasInvalidOrOversizedContentLength(rawRequest)) {
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

    let request: TRequest;
    try {
      request = await adapter.parse(rawRequest, context);
    } catch (error) {
      await cancelRetainedRequestBody(rawRequest, error);
      if (error instanceof RequestBodyTooLargeError) {
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
      if (error instanceof UnsupportedContentEncodingError) {
        return rejectRequest({
          source,
          session,
          rawRequest,
          inboundProtocol,
          response: adapter.errors.unsupportedContentEncoding(),
          errorCode: 'unsupported_content_encoding',
          error,
        });
      }
      const mapped = adapter.errors.requestError(error);
      if (mapped !== undefined) {
        const errorCode = mapped.status === 501 ? 'unsupported_feature' : 'invalid_request';
        return rejectRequest({
          source,
          session,
          rawRequest,
          inboundProtocol,
          response: mapped,
          errorCode,
          error,
        });
      }
      throw error;
    }
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

    const lease = source.acquireProviderSnapshot();
    let deferred = false;
    const deferRelease = () => {
      deferred = true;
    };
    try {
      const candidates = lease.snapshot.router.resolve(requestedModel, adapter.variant(request, context));
      return await attemptCandidates({
        adapter,
        candidates,
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
      if (error instanceof RouterModelNotFoundError) {
        const response = adapter.errors.modelNotFound(error.message);
        return rejectRequest({
          source,
          session,
          rawRequest,
          inboundProtocol,
          requestedModelId: requestedModel,
          response,
          errorCode: 'model_not_found',
          error,
        });
      }
      throw error;
    } finally {
      if (!deferred) lease.release();
    }
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
    }
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
  });
  logRequestRejected({ ...rejection, requestId: session.requestId, statusCode: response.status });
  return response;
}

export { resolveSupportedEfforts } from './attempt/effort-capability';
export { hasInvalidOrOversizedContentLength } from './request';
