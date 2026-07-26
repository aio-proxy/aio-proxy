import { assertImageInputSupported, type ModelEgressContext } from '@aio-proxy/core';

import { terminalCompletion } from '../../../route-observation';
import type { ModelTransport } from '../../../runtime';
import { attemptBase } from '../attempt-base';
import { createSseResponse, preflightStream } from '../stream';
import type { AttemptLoopContext, AttemptStep, CandidateSlot, InvocationHolder } from './context';
import { emitReject, resolveInvocation } from './model-prepare';

// Model dispatch for one candidate. The attempt span opens before the provider
// invocation so buffered (non-stream) requests still get a real span duration.
export async function attemptModelCandidate<TRequest, TContext>(
  ctx: AttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  model: ModelTransport,
  holder: InvocationHolder,
): Promise<AttemptStep> {
  const { adapter, request, context, rawRequest, session, source, logicalRequest, release, deferRelease } = ctx;
  const { index, candidate, startedAt, inAttempt } = slot;
  const provider = candidate.provider;

  const prepared = resolveInvocation(ctx, slot, model, holder);
  if (prepared.kind !== 'ok') return prepared.step;
  const { candidateInvocation, targetProtocol } = prepared;

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
    const unsupported = adapter.errors.unsupported(unsupportedProviderTool.type);
    return emitReject(ctx, slot, unsupported);
  }

  const base = attemptBase(provider, candidate.modelId, startedAt);
  const attemptSpan = ctx.emitter.startAttempt(base, index);
  slot.spanRef.current = attemptSpan;
  await inAttempt(() => model.ensureAvailable?.());
  const captured = source.usageCapture.stream({
    providerId: provider.id,
    modelId: candidate.modelId,
    ...(ctx.streamRequested ? { startedAt } : {}),
    stream: inAttempt(() =>
      model.invoke({
        context: logicalRequest,
        messages: candidateInvocation.messages,
        modelId: candidate.modelId,
        signal: rawRequest.signal,
        ...(candidateInvocation.settings === undefined ? {} : { settings: candidateInvocation.settings }),
        ...(candidateInvocation.tools === undefined ? {} : { tools: candidateInvocation.tools }),
        ...(candidateInvocation.providerTools === undefined
          ? {}
          : { providerTools: candidateInvocation.providerTools }),
      }),
    ),
  });
  let capturedResponseId: string | undefined;
  const egressContext = {
    modelId: candidate.modelId,
    ...(adapter.session === undefined
      ? {}
      : {
          onResponseId: (responseId: string) => {
            capturedResponseId = responseId;
            source.logicalSessionStore.commitResponse(responseId, logicalRequest.session.key);
          },
        }),
  } satisfies ModelEgressContext;
  const ids = { providerId: provider.id, modelId: candidate.modelId };

  if (adapter.wantsStream(request, context)) {
    const stream = await preflightStream(captured.value);
    let response: Response;
    try {
      response = createSseResponse(adapter.modelSse(stream, egressContext));
    } catch (error) {
      try {
        await stream.cancel(error);
      } catch {}
      throw error;
    }
    slot.spanRef.current = undefined;
    session.finishFrom(
      ctx.emitter.settleSuccess(
        attemptSpan,
        terminalCompletion(captured.completion, rawRequest.signal).finally(release),
        ids,
        () => capturedResponseId,
      ),
    );
    deferRelease();
    return { kind: 'return', response };
  }

  // Serialize before settling so a serialization throw is handled by the loop's
  // catch (reusing this span) instead of racing an immediate success completion.
  const value = await adapter.modelJson(captured.value, egressContext);
  const response = Response.json(value);
  slot.spanRef.current = undefined;
  session.finishFrom(
    ctx.emitter.settleSuccess(
      attemptSpan,
      terminalCompletion(captured.completion, rawRequest.signal),
      ids,
      () => capturedResponseId,
    ),
  );
  return { kind: 'return', response };
}
