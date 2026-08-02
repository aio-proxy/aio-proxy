import { assertImageInputSupported, type ModelInvocation } from '@aio-proxy/core';
import type { ProviderProtocol } from '@aio-proxy/types';

import type { ModelTransport } from '../../../runtime';
import { attemptBase } from '../attempt-base';
import { failureTerminal, finalFailure } from '../failure';
import { logRequestRejected } from '../logging';
import type { AttemptLoopContext, AttemptStep, CandidateSlot, InvocationHolder } from './context';
import { resolveSupportedEfforts } from './effort-capability';

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

// Rejects a candidate whose materialized invocation needs a capability this
// provider lacks (image input or a provider-native tool). Returns an early
// AttemptStep to fall back / finish, or undefined when the candidate is usable.
export function assertCandidateSupported<TRequest, TContext>(
  ctx: AttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  model: ModelTransport,
  candidateInvocation: ModelInvocation,
  targetProtocol: ProviderProtocol | undefined,
): AttemptStep | undefined {
  const { adapter } = ctx;
  try {
    assertImageInputSupported(candidateInvocation.messages, targetProtocol);
  } catch (error) {
    const unsupported = adapter.errors.modelUnsupported?.(error);
    if (unsupported === undefined) throw error;
    return emitReject(ctx, slot, unsupported, 'unsupported_feature');
  }
  const unsupportedProviderTool = candidateInvocation.providerTools?.find(
    (tool) => model.supportsProviderTool?.(tool.type) !== true,
  );
  if (unsupportedProviderTool !== undefined) {
    return emitReject(ctx, slot, adapter.errors.unsupported(unsupportedProviderTool.type));
  }
  return undefined;
}

// Resolves the target protocol and per-candidate effort capability, then
// materializes the invocation. Keeps the effort-capability lookup (a hot-path
// concern) out of the attempt orchestration in attemptModelCandidate.
export async function prepareModelInvocation<TRequest, TContext>(
  ctx: AttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  model: ModelTransport,
  holder: InvocationHolder,
): Promise<PreparedInvocation> {
  slot.trace.targetProtocol = model.targetProtocol?.(slot.candidate.modelId);
  const supportedEfforts = await resolveSupportedEfforts(slot.candidate.modelId);
  return resolveInvocation(ctx, slot, holder, slot.trace.targetProtocol, supportedEfforts);
}

// Materializes the model invocation once and reuses it across candidates,
// mapping conversion failures onto the protocol's error shapes.
export function resolveInvocation<TRequest, TContext>(
  ctx: AttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  holder: InvocationHolder,
  targetProtocol: ProviderProtocol | undefined,
  supportedEfforts: ReadonlySet<string>,
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
    candidateInvocation: adapter.modelInvocationForTarget(holder.invocation, targetProtocol, supportedEfforts),
    targetProtocol,
  };
}
