import { isInboundAbort, terminalCompletion } from '../../route-observation';
import type { RawTransport } from '../../runtime';
import { attemptBase } from './attempt-base';
import type { AttemptContext, AttemptOutcome, CandidateAttempt } from './attempt-context';
import { failedAttempt, finalFailure, shouldFallbackStatus } from './failure';
import { retainResponseBody } from './stream';

export async function attemptRawProvider<TRequest, TContext>(
  ctx: AttemptContext<TRequest, TContext>,
  slot: CandidateAttempt,
  raw: RawTransport,
): Promise<AttemptOutcome> {
  const { adapter, context, rawRequest, request, session, source, logicalRequest, release, deferRelease, logFailure } =
    ctx;
  const { index, candidate, startedAt, hasNext, inAttempt } = slot;
  const provider = candidate.provider;
  const upstream = await adapter.rawRequest(rawRequest, request, candidate.modelId, context);
  const response = await inAttempt(() => raw.invoke(upstream, logicalRequest));
  if (!(response instanceof Response)) throw new TypeError('Provider raw transport must return a Response');
  const fallback = hasNext && shouldFallbackStatus(response.status);
  if (fallback || response.status < 200 || response.status >= 400) {
    const attempt = failedAttempt(
      attemptBase(provider, candidate.modelId, startedAt, adapter.protocol),
      response.status,
    );
    logFailure(index, attempt, 'response', fallback, { response });
    if (fallback) {
      session.attempt(attempt);
      try {
        void response.body?.cancel().catch(() => undefined);
      } catch {}
      return { kind: 'fallback', lastFailure: response };
    }
    session.finish({
      outcome: 'failure',
      finalProviderId: attempt.providerId,
      finalModelId: attempt.modelId,
      finalStatusCode: response.status,
      attempt,
    });
    const retained = retainResponseBody(response, release);
    if (retained !== response) deferRelease();
    return { kind: 'return', response: retained };
  }
  const captured = source.usageCapture.passthrough({
    response,
    protocol: adapter.protocol,
    providerId: provider.id,
    modelId: candidate.modelId,
    ...(adapter.session === undefined
      ? {}
      : {
          onResponseId: (responseId: string) =>
            source.logicalSessionStore.commitResponse(responseId, logicalRequest.session.key),
        }),
  });
  session.finishFrom(
    attemptBase(provider, candidate.modelId, startedAt, adapter.protocol),
    terminalCompletion(captured.completion, rawRequest.signal).finally(release),
  );
  deferRelease();
  return { kind: 'return', response: captured.value };
}

export function unsupportedDispatch<TRequest, TContext>(
  ctx: AttemptContext<TRequest, TContext>,
  slot: CandidateAttempt,
): AttemptOutcome {
  const { adapter, session } = ctx;
  const { candidate, startedAt, hasNext } = slot;
  const provider = candidate.provider;
  const unsupported = adapter.errors.unsupported('transform_dispatch');
  if (hasNext) {
    session.attempt(failedAttempt(attemptBase(provider, candidate.modelId, startedAt), unsupported.status));
    return { kind: 'fallback', lastFailure: unsupported };
  }
  session.finish(finalFailure(attemptBase(provider, candidate.modelId, startedAt), unsupported.status));
  return { kind: 'return', response: unsupported };
}

export function handleAttemptError<TRequest, TContext>(
  ctx: AttemptContext<TRequest, TContext>,
  slot: CandidateAttempt,
  error: unknown,
): AttemptOutcome {
  const { adapter, rawRequest, session, logFailure } = ctx;
  const { index, candidate, startedAt, hasNext } = slot;
  const provider = candidate.provider;
  const mapped = adapter.errors.provider(error);
  if (mapped === undefined) {
    const attempt = { ...attemptBase(provider, candidate.modelId, startedAt), outcome: 'failure' as const };
    session.attempt(attempt);
    logFailure(index, attempt, 'exception', false, { error });
    throw error;
  }

  const cancelled = isInboundAbort(error, rawRequest.signal);
  const outcome = cancelled ? ('cancelled' as const) : ('failure' as const);
  const attempt = {
    ...attemptBase(provider, candidate.modelId, startedAt),
    outcome,
    statusCode: mapped.status,
  };
  const fallback = !cancelled && hasNext;

  if (!cancelled) {
    logFailure(index, attempt, 'exception', fallback, { error });
  }

  if (fallback) {
    session.attempt(attempt);
    return { kind: 'fallback', lastFailure: mapped };
  }

  session.finish({
    outcome,
    finalProviderId: provider.id,
    finalModelId: candidate.modelId,
    finalStatusCode: mapped.status,
    attempt,
  });
  return { kind: 'return', response: mapped };
}
