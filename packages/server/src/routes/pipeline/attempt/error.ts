import { upstreamRetryInfo } from '@aio-proxy/core';

import { isInboundAbort } from '../../../route-observation';
import { type AttemptInfo, attemptBase } from '../attempt-base';
import { failureTerminal, finalFailure } from '../failure';
import type { SpanTerminal } from '../tracing';
import type { AnyAttemptLoopContext, AttemptStep, CandidateSlot } from './context';
import { cooldownTtlMs } from './cooldown-write';
import { attemptLog } from './emit';

// Ends the candidate's attempt span: reuses the span opened before the provider
// call when present, otherwise opens and closes one for pre-invocation failures.
function endAttemptSpan<TRequest, TContext>(
  ctx: AnyAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  base: AttemptInfo,
  terminal: SpanTerminal,
): void {
  const open = slot.spanRef.current;
  if (open !== undefined) {
    slot.spanRef.current = undefined;
    ctx.emitter.endAttempt(open, slot.observation, terminal);
    return;
  }
  ctx.emitter.emitAttempt(base, slot.index, slot.observation, terminal);
}

// Terminates a candidate attempt on a rejection Response: falls back to the next
// candidate when one exists, otherwise finishes the request as terminal failure.
export function emitReject<TRequest, TContext>(
  ctx: AnyAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  response: Response,
  errorCode?: string,
): AttemptStep {
  const { candidate, startedAt, hasNext } = slot;
  const base = attemptBase(candidate.provider, candidate.modelId, startedAt, slot.trace);
  endAttemptSpan(ctx, slot, base, failureTerminal(response.status, errorCode));
  if (hasNext) {
    return { kind: 'fallback', lastFailure: response };
  }
  ctx.session.finish({ ...finalFailure(base, response.status, errorCode), clientResponse: response });
  return { kind: 'return', response };
}

// No transport on this candidate matched the inbound protocol's capability.
export function unsupportedDispatch<TRequest, TContext>(
  ctx: AnyAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
): AttemptStep {
  return emitReject(ctx, slot, ctx.adapter.errors.unsupported('transform_dispatch'));
}

// Maps a thrown provider error onto a protocol error response, distinguishing
// inbound cancellation from genuine failure and honoring fallback.
export function handleAttemptError<TRequest, TContext>(
  ctx: AnyAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  error: unknown,
): AttemptStep {
  const { adapter, rawRequest, session, logFailure } = ctx;
  const { index, candidate, startedAt, hasNext } = slot;
  const provider = candidate.provider;
  const base = attemptBase(provider, candidate.modelId, startedAt, slot.trace);
  const { protocol: _protocol, ...logBase } = base;
  const mapped = adapter.errors.provider(error);
  if (mapped === undefined) {
    endAttemptSpan(ctx, slot, base, { outcome: 'failure' });
    logFailure(index, attemptLog(logBase), 'exception', false, { error });
    throw error;
  }

  const cancelled = isInboundAbort(error, rawRequest.signal);
  const outcome = cancelled ? ('cancelled' as const) : ('failure' as const);
  const fallback = !cancelled && hasNext;

  if (!cancelled) {
    // Use the extracted upstream status (429), NOT mapped.status — a wrapped
    // AI-SDK 429 maps to 500 (see upstreamRetryInfo's recursive unwrap).
    const { status, retryAfter } = upstreamRetryInfo(error);
    if (status !== undefined) {
      const cooldownMs = cooldownTtlMs(status, retryAfter, ctx.retryAfterCapMs);
      if (cooldownMs > 0) ctx.cooldown.cool(provider.id, candidate.modelId, cooldownMs);
    }
  }

  if (!cancelled) {
    logFailure(index, attemptLog(logBase, mapped.status), 'exception', fallback, { error });
  }
  endAttemptSpan(ctx, slot, base, { outcome, httpStatus: mapped.status });

  if (fallback) {
    return { kind: 'fallback', lastFailure: mapped };
  }

  session.finish({
    outcome,
    finalProviderId: provider.id,
    finalModelId: candidate.modelId,
    finalHttpStatus: mapped.status,
    clientResponse: mapped,
  });
  return { kind: 'return', response: mapped };
}
