import { type ModelEgressContext } from '@aio-proxy/core';

import { terminalCompletion } from '../../../route-observation';
import type { ModelTransport } from '../../../runtime';
import { attemptBase, candidateConfigPrice } from '../attempt-base';
import { createSseResponse, preflightStream } from '../stream';
import type { AttemptLoopContext, AttemptStep, CandidateSlot, InvocationHolder } from './context';
import { assertCandidateSupported, prepareModelInvocation } from './model-prepare';

// Model dispatch for one candidate. The attempt span opens before the provider
// invocation so buffered (non-stream) requests still get a real span duration.
export async function attemptModelCandidate<TRequest, TContext>(
  ctx: AttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  model: ModelTransport,
  holder: InvocationHolder,
): Promise<AttemptStep> {
  const { adapter, rawRequest, session, source, logicalRequest, routingContinuity, release, deferRelease } = ctx;
  const { index, candidate, startedAt, observation, inAttempt } = slot;
  const provider = candidate.provider;

  const prepared = await prepareModelInvocation(ctx, slot, model, holder);
  if (prepared.kind !== 'ok') return prepared.step;
  const { candidateInvocation, targetProtocol } = prepared;

  const unsupported = assertCandidateSupported(ctx, slot, model, candidateInvocation, targetProtocol);
  if (unsupported !== undefined) return unsupported;

  const base = attemptBase(provider, candidate.modelId, startedAt, slot.trace);
  const attemptSpan = ctx.emitter.startAttempt(base, index);
  slot.spanRef.current = attemptSpan;
  await inAttempt(targetProtocol, () => model.ensureAvailable?.());
  const configPrice = candidateConfigPrice(provider, candidate.modelId);
  const captured = source.usageCapture.stream({
    providerId: provider.id,
    modelId: candidate.modelId,
    requestedModelId: ctx.requestedModelId,
    startedAt,
    observation,
    ...(configPrice === undefined ? {} : { configPrice }),
    stream: inAttempt(targetProtocol, () => {
      observation.markTransportUnavailable();
      return model.invoke({
        context: logicalRequest,
        messages: candidateInvocation.messages,
        modelId: candidate.modelId,
        routingContinuity,
        signal: rawRequest.signal,
        ...(candidateInvocation.settings === undefined ? {} : { settings: candidateInvocation.settings }),
        ...(candidateInvocation.tools === undefined ? {} : { tools: candidateInvocation.tools }),
        ...(candidateInvocation.providerTools === undefined
          ? {}
          : { providerTools: candidateInvocation.providerTools }),
      });
    }),
  });
  let capturedResponseId: string | undefined;
  const egressContext = {
    modelId: candidate.modelId,
    ...(adapter.session === undefined
      ? {}
      : {
          onResponseId: (responseId: string) => {
            capturedResponseId = responseId;
          },
        }),
  } satisfies ModelEgressContext;
  const ids = { providerId: provider.id, modelId: candidate.modelId };
  const commitCapturedResponse = () => {
    if (capturedResponseId === undefined) return;
    source.logicalSessionStore.commitResponse(
      capturedResponseId,
      logicalRequest.session.key,
      ctx.sessionIdentity,
      provider.id,
    );
  };
  const commitResponseOnSuccess = (completion: typeof captured.completion) =>
    completion.then((value) => {
      if (value.outcome === 'success') commitCapturedResponse();
      return value;
    });

  if (ctx.streamRequested) {
    const stream = await preflightStream(captured.value);
    let response: Response;
    let egressCompletion: typeof captured.completion;
    try {
      const egress = adapter.modelSse(stream, egressContext);
      response = createSseResponse(egress);
      egressCompletion = Promise.all([captured.completion, egress.completion]).then(([completion]) => completion);
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
        observation,
        commitResponseOnSuccess(terminalCompletion(egressCompletion, rawRequest.signal)).finally(release),
        ids,
        response,
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
  commitCapturedResponse();
  slot.spanRef.current = undefined;
  session.finishFrom(
    ctx.emitter.settleSuccess(
      attemptSpan,
      observation,
      terminalCompletion(captured.completion, rawRequest.signal),
      ids,
      response,
      () => capturedResponseId,
    ),
  );
  return { kind: 'return', response };
}
