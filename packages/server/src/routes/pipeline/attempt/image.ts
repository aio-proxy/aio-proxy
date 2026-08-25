import type { ImageProtocolAdapter } from '@aio-proxy/core';

import { supportsImageConvert, supportsImageRaw } from '../../../provider-runtime';
import { terminalCompletion } from '../../../route-observation';
import type { ImageTransport } from '../../../runtime';
import { captureImageUsage } from '../../../usage-capture/image-capture';
import { attemptBase, candidateConfigPrice } from '../attempt-base';
import { failureTerminal, finalFailure } from '../failure';
import { logRequestRejected } from '../logging';
import type { AttemptLoopContext, AttemptStep, CandidateSlot } from './context';
import { unsupportedDispatch } from './error';
import { attemptRawCandidate } from './raw';

export const IMAGE_RAW_IDLE_TIMEOUT_MS = 600_000;

type ImageAttemptLoopContext<TRequest, TContext> = Omit<AttemptLoopContext<TRequest, TContext>, 'adapter'> & {
  readonly adapter: ImageProtocolAdapter<TRequest, TContext>;
};

export async function dispatchImageCandidate<TRequest, TContext>(
  ctx: AttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
): Promise<AttemptStep> {
  const provider = slot.candidate.provider;
  if (supportsImageRaw(provider, slot.candidate.modelId)) {
    const raw = provider.raw?.resolve({ protocol: ctx.adapter.protocol, modelId: slot.candidate.modelId });
    if (raw === undefined) return unsupportedDispatch(ctx, slot);
    slot.trace.transport = 'raw';
    slot.trace.targetProtocol = ctx.adapter.protocol;
    return attemptRawCandidate(ctx, slot, raw, ctx.streamRequested ? { idleTimeoutMs: IMAGE_RAW_IDLE_TIMEOUT_MS } : {});
  }
  if (ctx.streamRequested) return { kind: 'skip', reason: 'stream' };
  if (supportsImageConvert(provider, slot.candidate.modelId) && provider.image !== undefined) {
    if (ctx.adapter.capability !== 'image') return unsupportedDispatch(ctx, slot);
    return attemptImageCandidate({ ...ctx, adapter: ctx.adapter }, slot, provider.image);
  }
  slot.trace.transport = undefined;
  slot.trace.targetProtocol = undefined;
  return unsupportedDispatch(ctx, slot);
}

export async function attemptImageCandidate<TRequest, TContext>(
  ctx: ImageAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  image: ImageTransport,
): Promise<AttemptStep> {
  const { adapter, context, rawRequest, request, session } = ctx;
  const { index, candidate, startedAt, observation, inAttempt } = slot;
  const provider = candidate.provider;
  const skipReason = adapter.convertSkipReason?.(request, candidate.modelId);
  if (skipReason !== undefined) return { kind: 'skip', reason: skipReason };

  slot.trace.transport = 'image';
  slot.trace.targetProtocol = undefined;

  let invocation;
  try {
    invocation = adapter.imageInvocation(request, context);
  } catch (error) {
    const mapped = adapter.errors.requestError(error);
    if (mapped === undefined) throw error;
    const errorCode = mapped.status === 501 ? 'unsupported_feature' : 'invalid_request';
    const base = attemptBase(provider, candidate.modelId, startedAt, slot.trace);
    ctx.emitter.emitAttempt(base, index, slot.observation, failureTerminal(mapped.status, errorCode));
    session.finish({ ...finalFailure(base, mapped.status, errorCode), clientResponse: mapped });
    logRequestRejected({
      source: ctx.source,
      requestId: session.requestId,
      rawRequest,
      inboundProtocol: adapter.protocol,
      requestedModelId: ctx.requestedModelId,
      statusCode: mapped.status,
      errorCode,
      error,
    });
    return { kind: 'return', response: mapped };
  }
  const base = attemptBase(provider, candidate.modelId, startedAt, slot.trace);
  const attemptSpan = ctx.emitter.startAttempt(base, index);
  slot.spanRef.current = attemptSpan;
  await inAttempt(undefined, () => image.ensureAvailable?.());
  const configPrice = candidateConfigPrice(provider, candidate.modelId);
  observation.markTransportUnavailable();
  const result = await inAttempt(undefined, () =>
    image.invoke({
      modelId: candidate.modelId,
      invocation,
      ...(rawRequest.signal === undefined ? {} : { signal: rawRequest.signal }),
    }),
  );
  const value = await adapter.imageJson(result, { modelId: candidate.modelId });
  const response = Response.json(value);
  const usage = await captureImageUsage({
    providerId: provider.id,
    modelId: candidate.modelId,
    requestedModelId: ctx.requestedModelId,
    imageCount: result.images.length,
    ...(result.usage === undefined ? {} : { usage: result.usage }),
    ...(configPrice === undefined ? {} : { configPrice }),
  });
  slot.spanRef.current = undefined;
  session.finishFrom(
    ctx.emitter.settleSuccess(
      attemptSpan,
      observation,
      terminalCompletion(
        Promise.resolve({
          outcome: 'success',
          statusCode: response.status,
          ...(usage === undefined ? {} : { usage }),
        }),
        rawRequest.signal,
      ),
      { providerId: provider.id, modelId: candidate.modelId },
      response,
    ),
  );
  return { kind: 'return', response };
}
