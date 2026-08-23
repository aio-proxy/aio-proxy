import type { ProtocolAdapter, RouterCandidate } from '@aio-proxy/core';
import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';
import { ProviderProtocol } from '@aio-proxy/types';

import { attributeName, type RequestTraceSession } from '../../../request-tracing';
import { isInboundAbort } from '../../../route-observation';
import type { RuntimeProviderInstance } from '../../../runtime';
import { resolveSupportedEffortsForDimensions } from '../../pipeline';
import { failureTerminal } from '../../pipeline/failure';
import { type CountAttempt, startAttemptSpan, throwIfCountAborted } from '../shared';

// Outcome the count loop consumes:
//   return      → hand this upstream response back verbatim
//   fallthrough → no raw transport; try this candidate's tokenCount path
//   next        → raw was attempted and failed; advance to the next candidate
// Abort is signalled by throwing.
export type RawCountResult =
  | { readonly kind: 'return'; readonly response: Response }
  | { readonly kind: 'fallthrough' }
  | { readonly kind: 'next' };

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
  attempt,
  attemptIndex,
  rawRequest,
  request,
  context,
  logicalRequest,
  session,
}: {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly candidate: RouterCandidate<RuntimeProviderInstance>;
  readonly attempt: CountAttempt;
  readonly attemptIndex: number;
  readonly rawRequest: Request;
  readonly request: TRequest;
  readonly context: TContext;
  readonly logicalRequest: LogicalRequestContext;
  readonly session: RequestTraceSession;
}): Promise<RawCountResult> {
  // The main raw-forward path is scoped to the anthropic protocol only: other adapters'
  // rawRequest rewrites to a generation endpoint (e.g. gemini :generateContent), which would
  // return a real completion in place of a token count. A gemini inbound has
  // adapter.protocol === Gemini and never reaches this branch. Non-anthropic requests fall
  // through to the candidate's own tokenCount capability.
  if (adapter.protocol !== ProviderProtocol.Anthropic) {
    return { kind: 'fallthrough' };
  }
  const raw = candidate.provider.raw?.resolve({ protocol: adapter.protocol, modelId: candidate.modelId });
  if (raw === undefined) return { kind: 'fallthrough' };

  throwIfCountAborted(session, rawRequest.signal);
  const attemptSpan = startAttemptSpan(session, attempt, attemptIndex);
  let response: Response | undefined;
  try {
    // Clamp adaptive effort to the candidate's real capabilities so an
    // unsupported level does not make the provider's count_tokens throw and
    // silently fall back to a local estimate. Skipped when there is no effort.
    const supportedEfforts = await resolveSupportedEffortsForDimensions(
      adapter.dimensions(request, context),
      candidate.modelId,
    );
    const upstream = await adapter.rawRequest(
      rawRequest.clone(),
      request,
      candidate.modelId,
      supportedEfforts,
      context,
    );
    response = await raw.invoke(upstream, logicalRequest, { upstreamStream: false });
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
        clientResponse: response,
      });
      return { kind: 'return', response };
    }
    attemptSpan.end(failureTerminal(response.status));
    discardResponse(response);
    return { kind: 'next' };
  } catch (error) {
    if (response !== undefined) discardResponse(response);
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
    return { kind: 'next' };
  }
}
