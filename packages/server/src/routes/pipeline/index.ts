import {
  type ProtocolAdapter,
  RequestBodyTooLargeError,
  RouterModelNotFoundError,
  UnsupportedContentEncodingError,
} from '@aio-proxy/core';
import { context } from '@opentelemetry/api';

import { observeInboundRequest, withRequestLogContext } from '../../request-logging';
import type { RequestTraceSession } from '../../request-tracing';
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
  const session = options.source.requestRecorder.begin({
    headers: options.rawRequest.headers,
    inboundProtocol: options.adapter.protocol,
  });
  return await context.with(session.rootContext, () =>
    withRequestLogContext(
      {
        requestId: session.requestId,
        debug: options.source.debugLogging === true,
        logger: options.source.logger,
      },
      async () => {
        const rawRequest = observeInboundRequest(options.rawRequest, options.adapter.protocol);
        return await handleProtocolRequestInContext({ ...options, rawRequest }, session);
      },
    ),
  );
}

async function handleProtocolRequestInContext<TRequest, TContext>(
  { adapter, context, rawRequest, source }: HandleProtocolRequestOptions<TRequest, TContext>,
  session: RequestTraceSession,
): Promise<Response> {
  let requestedModelId: string | undefined;
  let releaseRetainedBody = false;
  try {
    if (hasInvalidOrOversizedContentLength(rawRequest)) {
      const error = new RequestBodyTooLargeError('Request body too large');
      await cancelRetainedRequestBody(rawRequest, error);
      return rejectRequest({
        source,
        session,
        rawRequest,
        inboundProtocol: adapter.protocol,
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
          inboundProtocol: adapter.protocol,
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
          inboundProtocol: adapter.protocol,
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
          inboundProtocol: adapter.protocol,
          response: mapped,
          errorCode,
          error,
        });
      }
      throw error;
    }
    releaseRetainedBody = true;

    const requestedModel = adapter.model(request, context);
    requestedModelId = requestedModel;
    const resolution = source.logicalSessionStore.begin({
      requestedModelId: requestedModel,
      hints: adapter.session?.(request, context) ?? { candidates: [], transcript: request },
      headers: rawRequest.headers,
    });
    session.identify({ requestedModelId: requestedModel, resolution, mutateSessionState: true });
    logRequestDiagnostics({
      source,
      requestId: session.requestId,
      rawRequest,
      inboundProtocol: adapter.protocol,
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
        context,
        deferRelease,
        rawRequest,
        release: lease.release,
        request,
        requestedModelId: requestedModel,
        resolution,
        session,
        source,
      });
    } catch (error) {
      if (error instanceof RouterModelNotFoundError) {
        const response = adapter.errors.modelNotFound(error.message);
        return rejectRequest({
          source,
          session,
          rawRequest,
          inboundProtocol: adapter.protocol,
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
    if (session.finish({ outcome: 'failure', errorCode: 'internal_error' })) {
      logRequestFailed({
        source,
        requestId: session.requestId,
        rawRequest,
        inboundProtocol: adapter.protocol,
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

export { hasInvalidOrOversizedContentLength } from './request';
