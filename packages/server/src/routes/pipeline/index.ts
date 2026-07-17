import { type ProtocolAdapter, RequestBodyTooLargeError, RouterModelNotFoundError } from "@aio-proxy/core";
import type { RequestSession } from "../../request-recorder";
import type { ProviderRouteSource } from "../../runtime";
import { attemptCandidates } from "./attempt";
import { logRequestDiagnostics, logRequestFailed, logRequestRejected } from "./logging";
import { hasInvalidOrOversizedContentLength } from "./request";

export type HandleProtocolRequestOptions<TRequest, TContext> = {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly context: TContext;
  readonly rawRequest: Request;
  readonly source: ProviderRouteSource;
};

export async function handleProtocolRequest<TRequest, TContext>({
  adapter,
  context,
  rawRequest,
  source,
}: HandleProtocolRequestOptions<TRequest, TContext>): Promise<Response> {
  const session = source.requestRecorder.begin({ inboundProtocol: adapter.protocol });
  let requestedModelId: string | undefined;
  try {
    if (hasInvalidOrOversizedContentLength(rawRequest)) {
      const response = adapter.errors.tooLarge();
      return rejectRequest({
        source,
        session,
        rawRequest,
        inboundProtocol: adapter.protocol,
        response,
        errorCode: "request_too_large",
        error: new RequestBodyTooLargeError("Request body too large"),
      });
    }

    let request: TRequest;
    try {
      request = await adapter.parse(rawRequest, context);
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) {
        const response = adapter.errors.tooLarge();
        return rejectRequest({
          source,
          session,
          rawRequest,
          inboundProtocol: adapter.protocol,
          response,
          errorCode: "request_too_large",
          error,
        });
      }
      const mapped = adapter.errors.requestError(error);
      if (mapped !== undefined) {
        const errorCode = mapped.status === 501 ? "unsupported_feature" : "invalid_request";
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

    const requestedModel = adapter.model(request, context);
    requestedModelId = requestedModel;
    session.identify({ requestedModelId: requestedModel });
    logRequestDiagnostics({
      source,
      session,
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
          errorCode: "model_not_found",
          error,
        });
      }
      throw error;
    } finally {
      if (!deferred) lease.release();
    }
  } catch (error) {
    if (session.finish({ outcome: "failure", errorCode: "internal_error" })) {
      logRequestFailed({
        source,
        session,
        rawRequest,
        inboundProtocol: adapter.protocol,
        ...(requestedModelId === undefined ? {} : { requestedModelId }),
        error,
      });
    }
    throw error;
  }
}

function rejectRequest(options: {
  readonly source: ProviderRouteSource;
  readonly session: RequestSession;
  readonly rawRequest: Request;
  readonly inboundProtocol: string;
  readonly requestedModelId?: string;
  readonly response: Response;
  readonly errorCode: string;
  readonly error: unknown;
}): Response {
  const { response, ...rejection } = options;
  rejection.session.finish({
    outcome: "failure",
    finalStatusCode: response.status,
    errorCode: rejection.errorCode,
  });
  logRequestRejected({ ...rejection, statusCode: response.status });
  return response;
}

export { hasInvalidOrOversizedContentLength } from "./request";
