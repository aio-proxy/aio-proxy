import { EvaluationDistributionError } from '@aio-proxy/core';

import { terminalCompletion } from '../../../route-observation';
import type { LazyEvaluationTransport } from '../../../runtime';
import { withoutCallerCredentialsOnRequest } from '../../../server/api-key-auth';
import { attemptBase } from '../attempt-base';
import type { AttemptStep, CandidateSlot, EvaluationAttemptLoopContext } from './context';
import { attemptLog } from './emit';
import { emitReject } from './error';
import { completeRawAttempt, startRawAttempt } from './raw';
import { requestPathProperty } from './request-path';

/**
 * Evaluation dispatch for one candidate. Same-protocol raw wins, otherwise the
 * request converts into an evaluation invocation. A language model transport is
 * never consulted: evaluations do not travel as model messages.
 *
 * Admission composes two independent inputs, and raw is the stronger one: a
 * candidate with a matching System One raw transport is eligible whatever the
 * convert probe says, and the probe is never awaited on that path.
 */
export async function attemptEvaluationCandidate<TRequest, TContext>(
  ctx: EvaluationAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
): Promise<AttemptStep> {
  const { adapter, context, rawRequest, request } = ctx;
  const { candidate } = slot;
  const provider = candidate.provider;
  const raw = provider.raw?.resolve({
    protocol: adapter.protocol,
    modelId: candidate.modelId,
    capability: 'evaluation',
    ...requestPathProperty(rawRequest),
  });
  if (raw !== undefined) {
    slot.trace.transport = 'raw';
    slot.trace.targetProtocol = adapter.protocol;
    const attemptSpan = startRawAttempt(ctx, slot);
    // No supported efforts: an evaluation carries no reasoning effort to clamp.
    const rewritten = await adapter.rawRequest(rawRequest, request, candidate.modelId, context);
    // This path does not go through `attemptRawCandidate`, so the strip there never
    // runs. An anonymously admitted caller still carries its own secrets, and the
    // endpoint transport copies the inbound query onto the upstream URL verbatim.
    const upstream = withoutCallerCredentialsOnRequest(rewritten);
    return await completeRawAttempt(ctx, slot, raw, upstream, attemptSpan);
  }
  // Absence of the field is the only thing it can answer. Presence proves nothing:
  // the transport is attached to every `ai-sdk` provider because no static signal
  // speaks for an arbitrary npm package, so the verdict comes from `discover()`.
  const evaluation = provider.evaluation;
  if (evaluation === undefined) return unsupportedConvert(ctx, slot);
  return await convertEvaluationCandidate(ctx, slot, evaluation);
}

async function convertEvaluationCandidate<TRequest, TContext>(
  ctx: EvaluationAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  evaluation: LazyEvaluationTransport,
): Promise<AttemptStep> {
  const { adapter, context, rawRequest, request, session } = ctx;
  const { candidate, startedAt, observation, inAttempt } = slot;
  const provider = candidate.provider;

  const discovered = await evaluation.discover();
  if (discovered.kind === 'unsupported') return unsupportedConvert(ctx, slot);
  if (discovered.kind === 'failed') return discoveryFailure(ctx, slot, discovered.error);

  slot.trace.transport = 'ai_sdk';
  slot.trace.targetProtocol = undefined;
  const invocation = adapter.evaluationInvocation(request, context);
  const attemptSpan = ctx.emitter.startAttempt(
    attemptBase(provider, candidate.modelId, startedAt, slot.trace),
    slot.index,
  );
  slot.spanRef.current = attemptSpan;
  const result = await inAttempt(undefined, () => {
    observation.markTransportUnavailable();
    return discovered.evaluate(invocation, { modelId: candidate.modelId, signal: rawRequest.signal });
  });

  // Serialize before settling so an egress refusal falls back like any other
  // candidate failure instead of racing an already-resolved success. The response
  // `model` is the requested slug, never the resolved upstream id.
  let body: unknown;
  try {
    body = adapter.evaluationJson(result, { responseModelId: ctx.requestedModelId });
  } catch (error) {
    // `errors.provider` declines this deliberately, so `handleAttemptError` would
    // rethrow rather than fall back. The adapter owns the refusal; this layer owns
    // turning it into the next candidate's turn.
    if (!(error instanceof EvaluationDistributionError)) throw error;
    return emitReject(ctx, slot, adapter.errors.unsupported('evaluation_distribution'), 'unsupported_feature');
  }
  const response = Response.json(body);
  slot.spanRef.current = undefined;
  session.finishFrom(
    ctx.emitter.settleSuccess(
      attemptSpan,
      observation,
      terminalCompletion(Promise.resolve({ outcome: 'success', statusCode: response.status }), rawRequest.signal),
      { providerId: provider.id, modelId: candidate.modelId },
      response,
    ),
  );
  return { kind: 'return', response };
}

// No System One raw endpoint and no resolver behind the package: this candidate
// can never serve evaluation, so it declines and the loop moves on.
function unsupportedConvert<TRequest, TContext>(
  ctx: EvaluationAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
): AttemptStep {
  slot.trace.transport = undefined;
  slot.trace.targetProtocol = undefined;
  return emitReject(ctx, slot, ctx.adapter.errors.unsupported('evaluation_convert'), 'unsupported_feature');
}

/**
 * A package that could not be loaded or installed.
 *
 * Distinct from `unsupported` on purpose: this is a transient attempt failure, so
 * it must occupy this candidate's own position and fall back, never be hoisted
 * ahead of a healthy primary and never surface as a router miss. It cannot go
 * through `handleAttemptError` either — `errors.provider` declines an internal
 * error rather than echo its message to the caller, and that path rethrows what it
 * cannot map, which would take down a request whose next candidate is healthy. The
 * cause reaches the operator through the attempt log instead of the response body.
 */
function discoveryFailure<TRequest, TContext>(
  ctx: EvaluationAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  error: Error,
): AttemptStep {
  slot.trace.transport = undefined;
  slot.trace.targetProtocol = undefined;
  const response = ctx.adapter.errors.unsupported('evaluation_discovery');
  const { protocol: _protocol, ...logBase } = attemptBase(
    slot.candidate.provider,
    slot.candidate.modelId,
    slot.startedAt,
    slot.trace,
  );
  ctx.logFailure(slot.index, attemptLog(logBase, response.status, 'unsupported_feature'), 'exception', slot.hasNext, {
    error,
  });
  return emitReject(ctx, slot, response, 'unsupported_feature');
}
