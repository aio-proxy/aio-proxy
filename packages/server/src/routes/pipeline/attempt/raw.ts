import { attributeName } from '../../../request-tracing';
import { terminalCompletion } from '../../../route-observation';
import type { RawTransport } from '../../../runtime';
import { attemptBase, candidateConfigPrice } from '../attempt-base';
import { failureTerminal, finalFailure, shouldFallbackStatus } from '../failure';
import { retainResponseBody } from '../stream';
import type { AttemptLoopContext, AttemptStep, CandidateSlot } from './context';
import { cooldownTtlMs } from './cooldown-write';
import { resolveSupportedEfforts } from './effort-capability';
import { attemptLog } from './emit';

// Raw passthrough for one candidate. The attempt span opens before the provider
// call so its duration covers the upstream request, not just post-response work.
export async function attemptRawCandidate<TRequest, TContext>(
  ctx: AttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  raw: RawTransport,
): Promise<AttemptStep> {
  const { adapter, context, rawRequest, request, session, source, logicalRequest, release, deferRelease, logFailure } =
    ctx;
  const { index, candidate, startedAt, observation, hasNext, inAttempt } = slot;
  const provider = candidate.provider;
  const attemptSpan = ctx.emitter.startAttempt(attemptBase(provider, candidate.modelId, startedAt, slot.trace), index);
  slot.spanRef.current = attemptSpan;

  // Only resolve capabilities when the request carries an effort to clamp;
  // otherwise the rewrite has nothing to normalize and the hot-path catalog
  // read is pure overhead.
  const hasEffort = adapter.variant(request, context) !== undefined;
  const supportedEfforts = hasEffort ? await resolveSupportedEfforts(candidate.modelId) : new Set<string>();
  const upstream = await adapter.rawRequest(rawRequest, request, candidate.modelId, supportedEfforts, context);
  observation.markTransportUnavailable();
  const response = await inAttempt(adapter.protocol, () =>
    raw.invoke(upstream, logicalRequest, { upstreamStream: ctx.streamRequested }),
  );
  if (!(response instanceof Response)) throw new TypeError('Provider raw transport must return a Response');

  const fallback = hasNext && shouldFallbackStatus(response.status);
  if (fallback || response.status < 200 || response.status >= 400) {
    const cooldownMs = cooldownTtlMs(response.status, response.headers.get('retry-after'), ctx.retryAfterCapMs);
    if (cooldownMs > 0) ctx.cooldown.cool(provider.id, candidate.modelId, cooldownMs);
    const base = attemptBase(provider, candidate.modelId, startedAt, slot.trace);
    logFailure(index, attemptLog(base, response.status), 'response', fallback, { response });
    slot.spanRef.current = undefined;
    ctx.emitter.endAttempt(attemptSpan, observation, failureTerminal(response.status));
    if (fallback) {
      try {
        void response.body?.cancel().catch(() => undefined);
      } catch {}
      return { kind: 'fallback', lastFailure: response };
    }
    const retained = retainedFailure(response, ctx);
    session.finish({ ...finalFailure(base, retained.status), clientResponse: retained });
    return { kind: 'return', response: retained };
  }

  attemptSpan.span.setAttribute(attributeName.httpStatusCode, response.status);
  slot.spanRef.current = undefined;
  let capturedResponseId: string | undefined;
  const normalizedResponse = withEventStreamContentType(response, ctx.streamRequested);
  const configPrice = candidateConfigPrice(provider, candidate.modelId);
  const captured = source.usageCapture.passthrough({
    response: normalizedResponse,
    protocol: adapter.protocol,
    providerId: provider.id,
    modelId: candidate.modelId,
    requestedModelId: ctx.requestedModelId,
    observation,
    ...(configPrice === undefined ? {} : { configPrice }),
    ...(ctx.streamRequested ? { startedAt } : {}),
    ...(adapter.session === undefined
      ? {}
      : {
          onResponseId: (responseId: string) => {
            capturedResponseId = responseId;
          },
          onCommit: (responseId: string) => {
            source.logicalSessionStore.commitResponse(
              responseId,
              logicalRequest.session.key,
              ctx.sessionIdentity,
              provider.id,
            );
          },
        }),
  });
  session.finishFrom(
    ctx.emitter.settleSuccess(
      attemptSpan,
      observation,
      terminalCompletion(captured.completion, rawRequest.signal).finally(release),
      { providerId: provider.id, modelId: candidate.modelId },
      captured.value,
      () => capturedResponseId,
    ),
  );
  deferRelease();
  return { kind: 'return', response: captured.value };
}

function withEventStreamContentType(response: Response, streamRequested: boolean): Response {
  if (!streamRequested || !response.ok || response.body === null || response.headers.has('content-type')) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/event-stream; charset=utf-8');
  return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
}

function retainedFailure<TRequest, TContext>(
  response: Response,
  ctx: AttemptLoopContext<TRequest, TContext>,
): Response {
  const retained = retainResponseBody(response, ctx.release);
  if (retained !== response) ctx.deferRelease();
  return retained;
}
