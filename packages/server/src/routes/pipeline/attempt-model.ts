import { assertImageInputSupported, type ModelEgressContext, type ModelInvocation } from '@aio-proxy/core';

import { terminalCompletion } from '../../route-observation';
import type { ModelTransport } from '../../runtime';
import { attemptBase } from './attempt-base';
import type { AttemptContext, AttemptOutcome, CandidateAttempt, InvocationState } from './attempt-context';
import { failedAttempt, finalFailure } from './failure';
import { logRequestRejected } from './logging';
import { createSseResponse, preflightStream } from './stream';

export async function attemptModelProvider<TRequest, TContext>(
  ctx: AttemptContext<TRequest, TContext>,
  slot: CandidateAttempt,
  model: ModelTransport,
  invocationState: InvocationState,
): Promise<AttemptOutcome> {
  const prepared = prepareModelInvocation(ctx, slot, model, invocationState);
  if (prepared.kind !== 'proceed') return prepared;
  return executeModelInvocation(ctx, slot, model, prepared.candidateInvocation);
}

type PreparedInvocation = { readonly kind: 'proceed'; readonly candidateInvocation: ModelInvocation } | AttemptOutcome;

function prepareModelInvocation<TRequest, TContext>(
  ctx: AttemptContext<TRequest, TContext>,
  slot: CandidateAttempt,
  model: ModelTransport,
  invocationState: InvocationState,
): PreparedInvocation {
  const { adapter, context, rawRequest, request, requestedModelId, session, source } = ctx;
  const { candidate, startedAt, hasNext } = slot;
  const provider = candidate.provider;
  if (invocationState.invocation === undefined && invocationState.invocationUnsupported === undefined) {
    try {
      invocationState.invocation = adapter.modelInvocation(request, context);
    } catch (error) {
      const unsupported = adapter.errors.modelUnsupported?.(error);
      if (unsupported !== undefined) {
        invocationState.invocationUnsupported = unsupported;
      } else {
        const mapped = adapter.errors.requestError(error);
        if (mapped === undefined) throw error;
        const errorCode = mapped.status === 501 ? 'unsupported_feature' : 'invalid_request';
        session.finish(finalFailure(attemptBase(provider, candidate.modelId, startedAt), mapped.status, errorCode));
        logRequestRejected({
          source,
          session,
          rawRequest,
          inboundProtocol: adapter.protocol,
          requestedModelId,
          statusCode: mapped.status,
          errorCode,
          error,
        });
        return { kind: 'return', response: mapped };
      }
    }
  }
  if (invocationState.invocationUnsupported !== undefined) {
    const base = attemptBase(provider, candidate.modelId, startedAt);
    if (hasNext) {
      session.attempt(failedAttempt(base, invocationState.invocationUnsupported.status, 'unsupported_feature'));
      return { kind: 'fallback', lastFailure: invocationState.invocationUnsupported };
    }
    session.finish(finalFailure(base, invocationState.invocationUnsupported.status, 'unsupported_feature'));
    return { kind: 'return', response: invocationState.invocationUnsupported };
  }
  if (invocationState.invocation === undefined) throw new TypeError('Protocol adapter returned no model invocation');
  const targetProtocol = model.targetProtocol?.(candidate.modelId);
  const candidateInvocation = adapter.modelInvocationForTarget(invocationState.invocation, targetProtocol);
  try {
    assertImageInputSupported(candidateInvocation.messages, targetProtocol);
  } catch (error) {
    const unsupported = adapter.errors.modelUnsupported?.(error);
    if (unsupported === undefined) throw error;
    const base = attemptBase(provider, candidate.modelId, startedAt);
    if (hasNext) {
      session.attempt(failedAttempt(base, unsupported.status, 'unsupported_feature'));
      return { kind: 'fallback', lastFailure: unsupported };
    }
    session.finish(finalFailure(base, unsupported.status, 'unsupported_feature'));
    return { kind: 'return', response: unsupported };
  }
  const unsupportedProviderTool = candidateInvocation.providerTools?.find(
    (tool) => model.supportsProviderTool?.(tool.type) !== true,
  );
  if (unsupportedProviderTool !== undefined) {
    const unsupported = adapter.errors.unsupported(unsupportedProviderTool.type);
    if (hasNext) {
      session.attempt(failedAttempt(attemptBase(provider, candidate.modelId, startedAt), unsupported.status));
      return { kind: 'fallback', lastFailure: unsupported };
    }
    session.finish(finalFailure(attemptBase(provider, candidate.modelId, startedAt), unsupported.status));
    return { kind: 'return', response: unsupported };
  }
  return { kind: 'proceed', candidateInvocation };
}

async function executeModelInvocation<TRequest, TContext>(
  ctx: AttemptContext<TRequest, TContext>,
  slot: CandidateAttempt,
  model: ModelTransport,
  candidateInvocation: ModelInvocation,
): Promise<AttemptOutcome> {
  const { adapter, context, rawRequest, request, session, source, logicalRequest, release, deferRelease } = ctx;
  const { candidate, startedAt, inAttempt } = slot;
  const provider = candidate.provider;
  await inAttempt(() => model.ensureAvailable?.());
  const captured = source.usageCapture.stream({
    providerId: provider.id,
    modelId: candidate.modelId,
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
  const egressContext = {
    modelId: candidate.modelId,
    ...(adapter.session === undefined
      ? {}
      : {
          onResponseId: (responseId: string) =>
            source.logicalSessionStore.commitResponse(responseId, logicalRequest.session.key),
        }),
  } satisfies ModelEgressContext;

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
    session.finishFrom(
      attemptBase(provider, candidate.modelId, startedAt),
      terminalCompletion(captured.completion, rawRequest.signal).finally(release),
    );
    deferRelease();
    return { kind: 'return', response };
  }

  const value = await adapter.modelJson(captured.value, egressContext);
  const response = Response.json(value);
  session.finishFrom(
    attemptBase(provider, candidate.modelId, startedAt),
    terminalCompletion(captured.completion, rawRequest.signal),
  );
  return { kind: 'return', response };
}
