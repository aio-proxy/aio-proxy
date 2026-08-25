import {
  assertConvertSupported,
  EmbeddingConvertUnsupportedError,
  type EmbeddingEgressContext,
  type EmbeddingInvocation,
  EmbeddingUsageRequiredError,
} from '@aio-proxy/core';

import { terminalCompletion } from '../../../route-observation';
import type { EmbeddingTransport } from '../../../runtime';
import type { UsageCompletion } from '../../../usage-capture';
import { attemptBase, candidateConfigPrice } from '../attempt-base';
import type { AttemptStep, CandidateSlot, EmbeddingAttemptLoopContext } from './context';
import { emitReject, handleAttemptError, unsupportedDispatch } from './error';
import { completeRawAttempt, startRawAttempt } from './raw';

// Embedding dispatch for one candidate. Same-protocol raw wins, otherwise the
// request converts into an embedding invocation. A language model transport is
// never consulted: embeddings do not travel as model messages.
export async function attemptEmbeddingCandidate<TRequest, TContext>(
  ctx: EmbeddingAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
): Promise<AttemptStep> {
  const { adapter, context, rawRequest, request } = ctx;
  const { candidate } = slot;
  const provider = candidate.provider;
  const raw = provider.raw?.resolve({
    protocol: adapter.protocol,
    modelId: candidate.modelId,
    capability: 'embedding',
  });
  if (raw !== undefined) {
    slot.trace.transport = 'raw';
    slot.trace.targetProtocol = adapter.protocol;
    const attemptSpan = startRawAttempt(ctx, slot);
    // No supported efforts: embeddings carry no reasoning effort to clamp.
    const upstream = await adapter.rawRequest(rawRequest, request, candidate.modelId, context);
    return await completeRawAttempt(ctx, slot, raw, upstream, attemptSpan);
  }
  if (provider.embedding !== undefined) {
    slot.trace.transport = 'ai_sdk';
    slot.trace.targetProtocol = undefined;
    return await convertEmbeddingCandidate(ctx, slot, provider.embedding);
  }
  slot.trace.transport = undefined;
  slot.trace.targetProtocol = undefined;
  return unsupportedDispatch(ctx, slot);
}

async function convertEmbeddingCandidate<TRequest, TContext>(
  ctx: EmbeddingAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  embedding: EmbeddingTransport,
): Promise<AttemptStep> {
  const { adapter, context, rawRequest, request, session, source, logicalRequest } = ctx;
  const { candidate, startedAt, observation, inAttempt } = slot;
  const provider = candidate.provider;

  let invocation: EmbeddingInvocation;
  try {
    invocation = adapter.embeddingInvocation(request, context);
    assertConvertSupported(invocation.values);
  } catch (error) {
    if (!(error instanceof EmbeddingConvertUnsupportedError)) throw error;
    return emitReject(ctx, slot, adapter.errors.unsupported(error.feature), 'unsupported_feature');
  }

  const attemptSpan = ctx.emitter.startAttempt(
    attemptBase(provider, candidate.modelId, startedAt, slot.trace),
    slot.index,
  );
  slot.spanRef.current = attemptSpan;
  const result = await inAttempt(undefined, () => {
    observation.markTransportUnavailable();
    return embedding.embed(invocation, {
      modelId: candidate.modelId,
      signal: rawRequest.signal,
      logicalRequest,
    });
  });

  // Serialize before settling so an egress refusal — OpenAI will not emit a body
  // without usage — falls back like any other provider failure instead of
  // racing an already-resolved success.
  let payload: unknown;
  try {
    payload = adapter.embeddingJson(result, egressContext(candidate.modelId, invocation, context));
  } catch (error) {
    if (!(error instanceof EmbeddingUsageRequiredError)) throw error;
    return handleAttemptError(ctx, slot, error);
  }
  const response = Response.json(payload);
  slot.spanRef.current = undefined;
  const configPrice = candidateConfigPrice(provider, candidate.modelId);
  const completion: Promise<UsageCompletion> =
    result.usage === undefined
      ? Promise.resolve({ outcome: 'success' })
      : source.usageCapture.embedding({
          usage: result.usage,
          providerId: provider.id,
          modelId: candidate.modelId,
          requestedModelId: ctx.requestedModelId,
          ...(configPrice === undefined ? {} : { configPrice }),
        });
  session.finishFrom(
    ctx.emitter.settleSuccess(
      attemptSpan,
      observation,
      terminalCompletion(completion, rawRequest.signal),
      { providerId: provider.id, modelId: candidate.modelId },
      response,
    ),
  );
  return { kind: 'return', response };
}

function egressContext(modelId: string, invocation: EmbeddingInvocation, context: unknown): EmbeddingEgressContext {
  const action = embeddingAction(context);
  return {
    modelId,
    ...(invocation.encodingFormat === undefined ? {} : { encodingFormat: invocation.encodingFormat }),
    ...(action === undefined ? {} : { action }),
  };
}

// Gemini routes carry the requested envelope on the protocol context; other
// inbound protocols have no action and get the single-response shape.
function embeddingAction(context: unknown): EmbeddingEgressContext['action'] {
  if (typeof context !== 'object' || context === null || !('action' in context)) return undefined;
  const { action } = context;
  return action === 'embedContent' || action === 'batchEmbedContents' ? action : undefined;
}
