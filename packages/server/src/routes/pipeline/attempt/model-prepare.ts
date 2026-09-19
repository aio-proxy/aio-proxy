import { assertImageInputSupported, type ModelInvocation } from '@aio-proxy/core';
import type { ProviderProtocol } from '@aio-proxy/types';

import type { ModelTransport } from '../../../runtime';
import type {
  AttemptLoopContext,
  AttemptStep,
  CandidateSlot,
  InvocationHolder,
  LanguageAttemptLoopContext,
} from './context';
import { resolveSupportedEffortsForDimensions } from './effort-capability';
import { emitReject, type RequestShapeRejection } from './error';

export type PreparedInvocation =
  | {
      readonly kind: 'ok';
      readonly candidateInvocation: ModelInvocation;
      readonly targetProtocol: ProviderProtocol | undefined;
    }
  | ({ readonly kind: 'reject' } & RequestShapeRejection)
  // The adapter cannot express this request as a model invocation for ANY
  // candidate. Carried back as data rather than settled here: preparation runs
  // inside the attempt span, and emitting a rejection ends that span (and can
  // finish the request), which must not happen until the caller has closed its
  // prepare span.
  | { readonly kind: 'unsupported'; readonly response: Response };

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
  ctx: LanguageAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  model: ModelTransport,
  holder: InvocationHolder,
): Promise<PreparedInvocation> {
  slot.trace.targetProtocol = model.targetProtocol?.(slot.candidate.modelId);
  // Capabilities are only resolved when the request actually carries an effort
  // to clamp; the helper otherwise skips the hot-path catalog read for requests
  // (e.g. custom models) that have nothing to normalize.
  const supportedEfforts = await resolveSupportedEffortsForDimensions(
    ctx.adapter.dimensions(ctx.request, ctx.context),
    slot.candidate.modelId,
    slot.candidate.provider.upstreamMetadata?.[slot.candidate.modelId],
  );
  return resolveInvocation(ctx, holder, slot.trace.targetProtocol, supportedEfforts);
}

// Materializes the model invocation once and reuses it across candidates,
// mapping conversion failures onto the protocol's error shapes. Pure with
// respect to tracing: every failure is returned, never emitted, so the caller
// controls when the attempt and prepare spans close.
export function resolveInvocation<TRequest, TContext>(
  ctx: LanguageAttemptLoopContext<TRequest, TContext>,
  holder: InvocationHolder,
  targetProtocol: ProviderProtocol | undefined,
  supportedEfforts: ReadonlySet<string>,
): PreparedInvocation {
  const { adapter, request, context } = ctx;

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
        return {
          kind: 'reject',
          response: mapped,
          errorCode: mapped.status === 501 ? 'unsupported_feature' : 'invalid_request',
          error,
        };
      }
    }
  }
  if (holder.invocationUnsupported !== undefined) {
    return { kind: 'unsupported', response: holder.invocationUnsupported };
  }
  if (holder.invocation === undefined) throw new TypeError('Protocol adapter returned no model invocation');
  return {
    kind: 'ok',
    candidateInvocation: adapter.modelInvocationForTarget(holder.invocation, targetProtocol, supportedEfforts),
    targetProtocol,
  };
}
