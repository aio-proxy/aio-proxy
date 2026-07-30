import type { ModelInvocation } from '@aio-proxy/core';
import type { ProviderProtocol } from '@aio-proxy/types';

import { attemptBase } from '../attempt-base';
import { failureTerminal, finalFailure } from '../failure';
import { logRequestRejected } from '../logging';
import type { AttemptLoopContext, AttemptStep, CandidateSlot, InvocationHolder } from './context';

export type PreparedInvocation =
  | {
      readonly kind: 'ok';
      readonly candidateInvocation: ModelInvocation;
      readonly targetProtocol: ProviderProtocol | undefined;
    }
  | { readonly kind: 'step'; readonly step: AttemptStep };

// Terminates a candidate attempt on a rejection Response: falls back to the next
// candidate when one exists, otherwise finishes the request as terminal failure.
export function emitReject<TRequest, TContext>(
  ctx: AttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  response: Response,
  errorCode?: string,
): AttemptStep {
  const { index, candidate, startedAt, hasNext } = slot;
  const base = attemptBase(candidate.provider, candidate.modelId, startedAt, slot.trace);
  ctx.emitter.emitAttempt(base, index, slot.observation, failureTerminal(response.status, errorCode));
  if (hasNext) {
    return { kind: 'fallback', lastFailure: response };
  }
  ctx.session.finish(finalFailure(base, response.status, errorCode));
  return { kind: 'return', response };
}

// Materializes the model invocation once and reuses it across candidates,
// mapping conversion failures onto the protocol's error shapes.
export function resolveInvocation<TRequest, TContext>(
  ctx: AttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  holder: InvocationHolder,
  targetProtocol: ProviderProtocol | undefined,
): PreparedInvocation {
  const { adapter, request, context, rawRequest, session, source, requestedModelId } = ctx;
  const { index, candidate, startedAt } = slot;

  if (holder.invocation === undefined && holder.invocationUnsupported === undefined) {
    try {
      holder.invocation = adapter.modelInvocation(request, context);
    } catch (error) {
      const unsupported = adapter.errors.modelUnsupported?.(error);
      if (unsupported !== undefined) {
        holder.invocationUnsupported = unsupported;
      } else {
        const mapped = adapter.errors.requestError(error);
        if (mapped === undefined) throw error;
        const errorCode = mapped.status === 501 ? 'unsupported_feature' : 'invalid_request';
        const base = attemptBase(candidate.provider, candidate.modelId, startedAt, slot.trace);
        ctx.emitter.emitAttempt(base, index, slot.observation, failureTerminal(mapped.status, errorCode));
        session.finish(finalFailure(base, mapped.status, errorCode));
        logRequestRejected({
          source,
          requestId: session.requestId,
          rawRequest,
          inboundProtocol: adapter.protocol,
          requestedModelId,
          statusCode: mapped.status,
          errorCode,
          error,
        });
        return { kind: 'step', step: { kind: 'return', response: mapped } };
      }
    }
  }
  if (holder.invocationUnsupported !== undefined) {
    return { kind: 'step', step: emitReject(ctx, slot, holder.invocationUnsupported, 'unsupported_feature') };
  }
  if (holder.invocation === undefined) throw new TypeError('Protocol adapter returned no model invocation');
  return {
    kind: 'ok',
    candidateInvocation: adapter.modelInvocationForTarget(holder.invocation, targetProtocol),
    targetProtocol,
  };
}
