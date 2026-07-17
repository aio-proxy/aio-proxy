import { type ProtocolAdapter, RequestBodyTooLargeError, RouterModelNotFoundError } from "@aio-proxy/core";
import type { ProviderRouteSource } from "../../runtime";
import { attemptCandidates } from "./attempt";
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
  if (hasInvalidOrOversizedContentLength(rawRequest)) return adapter.errors.tooLarge();

  let request: TRequest;
  try {
    request = await adapter.parse(rawRequest, context);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return adapter.errors.tooLarge();
    const mapped = adapter.errors.requestError(error);
    if (mapped !== undefined) return mapped;
    throw error;
  }

  const requestedModel = adapter.model(request, context);
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
      requestedModel,
      source,
    });
  } catch (error) {
    if (error instanceof RouterModelNotFoundError) return adapter.errors.modelNotFound(error.message);
    throw error;
  } finally {
    if (!deferred) lease.release();
  }
}

export { hasInvalidOrOversizedContentLength } from "./request";
