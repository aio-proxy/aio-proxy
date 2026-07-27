import { isInboundAbort } from '../../../route-observation';
import { type AttemptInfo, attemptBase } from '../attempt-base';
import { failureTerminal, finalFailure } from '../failure';
import type { SpanTerminal } from '../tracing';
import type { AttemptLoopContext, AttemptStep, CandidateSlot } from './context';
import { attemptLog } from './emit';

// Ends the candidate's attempt span: reuses the span opened before the provider
// call when present, otherwise opens and closes one for pre-invocation failures.
function endAttemptSpan<TRequest, TContext>(
  ctx: AttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  base: AttemptInfo,
  terminal: SpanTerminal,
): void {
  const open = slot.spanRef.current;
  if (open !== undefined) {
    slot.spanRef.current = undefined;
    open.end(terminal);
    return;
  }
  ctx.emitter.emitAttempt(base, slot.index, terminal);
}

// No raw or model capability matched the inbound protocol for this candidate.
export function unsupportedDispatch<TRequest, TContext>(
  ctx: AttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
): AttemptStep {
  const { candidate, startedAt, hasNext, index } = slot;
  const unsupported = ctx.adapter.errors.unsupported('transform_dispatch');
  const base = attemptBase(candidate.provider, candidate.modelId, startedAt, slot.trace);
  ctx.emitter.emitAttempt(base, index, failureTerminal(unsupported.status));
  if (hasNext) {
    return { kind: 'fallback', lastFailure: unsupported };
  }
  ctx.session.finish(finalFailure(base, unsupported.status));
  return { kind: 'return', response: unsupported };
}

// Maps a thrown provider error onto a protocol error response, distinguishing
// inbound cancellation from genuine failure and honoring fallback.
export function handleAttemptError<TRequest, TContext>(
  ctx: AttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  error: unknown,
): AttemptStep {
  const { adapter, rawRequest, session, logFailure } = ctx;
  const { index, candidate, startedAt, hasNext } = slot;
  const provider = candidate.provider;
  const base = attemptBase(provider, candidate.modelId, startedAt, slot.trace);
  const logBase = { ...base, protocol: undefined };
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
  });
  return { kind: 'return', response: mapped };
}
