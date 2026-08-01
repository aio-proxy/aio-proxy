import type { ProtocolAdapter, RouterResolution } from '@aio-proxy/core';
import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';

import { attributeName, type RequestTraceSession } from '../request-tracing';
import { isInboundAbort } from '../route-observation';
import type { RuntimeProviderInstance } from '../runtime';
import { failureTerminal } from './pipeline/failure';
import { type CountAttempt, startAttemptSpan, throwIfCountAborted } from './token-count';

// Outcome the count loop consumes: either return this upstream response verbatim,
// or fall through to the next candidate / estimator. Abort is signalled by throwing.
export type RawCountResult = { readonly kind: 'return'; readonly response: Response } | { readonly kind: 'continue' };

// Abandon an upstream response we will not return, releasing its stream/connection.
function discardResponse(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {}
}

// Same-protocol raw passthrough for one count candidate. Mirrors attemptRawCandidate:
// the attempt span opens before the upstream call so its duration covers the request.
export async function attemptRawCount<TRequest, TContext>({
  adapter,
  candidate,
  attemptIndex,
  rawRequest,
  request,
  context,
  session,
}: {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly candidate: RouterResolution<RuntimeProviderInstance>;
  readonly attemptIndex: number;
  readonly rawRequest: Request;
  readonly request: TRequest;
  readonly context: LogicalRequestContext;
  readonly session: RequestTraceSession;
}): Promise<RawCountResult> {
  const raw = candidate.provider.raw?.resolve({ protocol: adapter.protocol, modelId: candidate.modelId });
  if (raw === undefined) return { kind: 'continue' };

  throwIfCountAborted(session, rawRequest.signal);
  const attempt: CountAttempt = {
    providerId: candidate.provider.id,
    modelId: candidate.modelId,
    providerKind: candidate.provider.kind,
  };
  const attemptSpan = startAttemptSpan(session, attempt, attemptIndex);
  try {
    const upstream = await adapter.rawRequest(rawRequest.clone(), request, candidate.modelId, context);
    const response = await raw.invoke(upstream, context, { upstreamStream: false });
    if (!(response instanceof Response)) throw new TypeError('Provider raw transport must return a Response');
    rawRequest.signal.throwIfAborted();
    attemptSpan.span.setAttribute(attributeName.httpStatusCode, response.status);
    if (response.status >= 200 && response.status < 400) {
      attemptSpan.end();
      session.finish({
        outcome: 'success',
        finalProviderId: candidate.provider.id,
        finalModelId: candidate.modelId,
        finalHttpStatus: response.status,
      });
      return { kind: 'return', response };
    }
    attemptSpan.end(failureTerminal(response.status));
    discardResponse(response);
    return { kind: 'continue' };
  } catch (error) {
    if ((rawRequest.signal.aborted && error === rawRequest.signal.reason) || isInboundAbort(error, rawRequest.signal)) {
      attemptSpan.end({ outcome: 'cancelled' });
      session.finish({ outcome: 'cancelled', finalProviderId: candidate.provider.id, finalModelId: candidate.modelId });
      throw rawRequest.signal.reason;
    }
    if (rawRequest.signal.aborted) {
      attemptSpan.end({ outcome: 'failure' });
      throw error;
    }
    const mapped = adapter.errors.provider(error);
    attemptSpan.end(failureTerminal(mapped?.status));
    if (mapped === undefined) throw error;
    return { kind: 'continue' };
  }
}
