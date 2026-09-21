import { type ModelEgressContext } from '@aio-proxy/core';

import { attributeName, spanName } from '../../../request-tracing';
import { terminalCompletion } from '../../../route-observation';
import type { ModelTransport } from '../../../runtime';
import { attemptBase, candidateConfigPrice } from '../attempt-base';
import { logModelInvocationDiagnostics } from '../logging';
import { publicSlug } from '../public-slug';
import { createSseResponse, preflightStream } from '../stream';
import { startPipelineSpan } from '../tracing';
import type { AttemptStep, CandidateSlot, InvocationHolder, LanguageAttemptLoopContext } from './context';
import { genAiProviderNameFor } from './emit';
import { emitReject, rejectRequestShape } from './error';
import { assertCandidateSupported, prepareModelInvocation } from './model-prepare';

// Model dispatch for one candidate. The attempt span opens before preparation
// and the provider invocation, so it measures the whole attempt: preparation is
// a child span rather than an untracked offset, and buffered (non-stream)
// requests still get a real span duration.
export async function attemptModelCandidate<TRequest, TContext>(
  ctx: LanguageAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  model: ModelTransport,
  holder: InvocationHolder,
): Promise<AttemptStep> {
  const { adapter, rawRequest, session, source, logicalRequest, routingContinuity, release, deferRelease } = ctx;
  const { index, candidate, startedAt, observation, inAttempt } = slot;
  const provider = candidate.provider;

  // The attempt span opens FIRST: prepare is a measured child of it, not an
  // untracked offset between the candidate's startedAt and the span.
  const attemptSpan = ctx.emitter.startAttempt(attemptBase(provider, candidate.modelId, startedAt, slot.trace), index);
  slot.spanRef.current = attemptSpan;
  // prepare 先写下 targetProtocol，后面的 materialize / ForTarget 才可能抛。
  // 抛出去的那条走 handleAttemptError，必须在这里先把协议口味挂上。
  const attachResolvedProtocol = (): void => {
    const target = slot.trace.targetProtocol;
    if (target === undefined) return;
    attemptSpan.span.setAttribute(attributeName.targetProtocol, target);
    const providerName = genAiProviderNameFor(target);
    if (providerName !== undefined) attemptSpan.span.setAttribute(attributeName.genAiProviderName, providerName);
  };

  // Mirrors resolveInvocation's memoization guard: the invocation is
  // materialized once for the request and reused by every later candidate.
  const prepareMode =
    holder.invocation === undefined && holder.invocationUnsupported === undefined ? 'materialize' : 'reuse';
  const prepareSpan = startPipelineSpan(attemptSpan.context, spanName.prepare, {
    attributes: { [attributeName.prepareMode]: prepareMode },
  });
  // Not `finally`: a prepare throw travels to the candidate loop's catch and on
  // to session.finish(), which drains the span buffer — a span left open past
  // that point is dropped from the trace entirely.
  const prepared = await prepareModelInvocation(ctx, slot, model, holder).then(
    (value) => {
      prepareSpan.end(value.kind === 'ok' ? undefined : { outcome: 'failure' });
      return value;
    },
    (error: unknown) => {
      prepareSpan.end({ outcome: 'failure' });
      attachResolvedProtocol();
      throw error;
    },
  );
  // Every exit below is settled here rather than inside prepare, so this runs
  // while the attempt span is still open: prepare resolves the target protocol
  // too late for it to be a creation attribute, and the reject and unsupported
  // exits end the span the moment they are emitted.
  attachResolvedProtocol();
  if (prepared.kind === 'reject') return rejectRequestShape(ctx, slot, prepared);
  if (prepared.kind === 'unsupported') return emitReject(ctx, slot, prepared.response, 'unsupported_feature');
  const { candidateInvocation, targetProtocol } = prepared;

  const unsupported = assertCandidateSupported(ctx, slot, model, candidateInvocation, targetProtocol);
  if (unsupported !== undefined) return unsupported;

  logModelInvocationDiagnostics({
    source,
    requestId: session.requestId,
    rawRequest,
    inboundProtocol: adapter.protocol,
    diagnostics: candidateInvocation.diagnostics ?? [],
    providerId: provider.id,
    attemptIndex: index,
  });
  await inAttempt(targetProtocol, () => model.ensureAvailable?.());
  const configPrice = candidateConfigPrice(
    ctx.routerModels,
    publicSlug(ctx.requestedModelId, candidate),
    provider.id,
    provider.upstreamMetadata?.[candidate.modelId]?.cost,
  );
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
    ...adapter.egressContext?.(ctx.request, ctx.context),
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
