import { attributeName } from '../../../request-tracing';
import { terminalCompletion } from '../../../route-observation';
import type { RawTransport } from '../../../runtime';
import { attemptBase, candidateConfigPrice } from '../attempt-base';
import { failureTerminal, finalFailure, shouldFallbackStatus } from '../failure';
import { publicSlug } from '../public-slug';
import { retainResponseBody } from '../stream';
import type { OpenSpan } from '../tracing';
import type { AnyAttemptLoopContext, AttemptStep, CandidateSlot, RawCapableAttemptLoopContext } from './context';
import { cooldownTtlMs } from './cooldown-write';
import { resolveSupportedEffortsForDimensions } from './effort-capability';
import { attemptLog } from './emit';

// Raw passthrough for one candidate. The attempt span opens before the provider
// call so its duration covers the upstream request, not just post-response work.
export async function attemptRawCandidate<TRequest, TContext>(
  ctx: RawCapableAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  raw: RawTransport,
  options: { readonly idleTimeoutMs?: number } = {},
): Promise<AttemptStep> {
  const { adapter, context, rawRequest, request } = ctx;
  const attemptSpan = startRawAttempt(ctx, slot);
  // Capabilities are only resolved when the request carries an effort to
  // clamp; otherwise the helper returns an empty set without a catalog read.
  const supportedEfforts = await resolveSupportedEffortsForDimensions(
    adapter.dimensions(request, context),
    slot.candidate.modelId,
  );
  const upstream = await adapter.rawRequest(rawRequest, request, slot.candidate.modelId, supportedEfforts, context);
  return await completeRawAttempt(ctx, slot, raw, upstream, attemptSpan, options);
}

// Opens the attempt span before the rewritten request is built, so the span
// duration covers request rewriting as well as the upstream call.
export function startRawAttempt<TRequest, TContext>(
  ctx: AnyAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
): OpenSpan {
  const { candidate, startedAt, index } = slot;
  const attemptSpan = ctx.emitter.startAttempt(
    attemptBase(candidate.provider, candidate.modelId, startedAt, slot.trace),
    index,
  );
  slot.spanRef.current = attemptSpan;
  return attemptSpan;
}

// Invokes the raw transport and applies the shared success / fallback status
// rules. Every inbound capability that passes a request through untouched uses
// this, so the fallback statuses and cooldown writes stay identical.
export async function completeRawAttempt<TRequest, TContext>(
  ctx: AnyAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  raw: RawTransport,
  upstream: Request,
  attemptSpan: OpenSpan,
  options: { readonly idleTimeoutMs?: number } = {},
): Promise<AttemptStep> {
  const { adapter, rawRequest, session, source, logicalRequest, release, deferRelease, logFailure } = ctx;
  const { index, candidate, startedAt, observation, hasNext, inAttempt } = slot;
  const provider = candidate.provider;
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
  const configPrice = candidateConfigPrice(
    ctx.routerModels,
    publicSlug(ctx.requestedModelId, candidate),
    provider.id,
    provider.upstreamMetadata?.[candidate.modelId]?.cost,
  );
  const captured = source.usageCapture.passthrough({
    response: normalizedResponse,
    protocol: adapter.protocol,
    providerId: provider.id,
    modelId: candidate.modelId,
    requestedModelId: ctx.requestedModelId,
    observation,
    ...(configPrice === undefined ? {} : { configPrice }),
    ...(ctx.streamRequested ? { startedAt } : {}),
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
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
  ctx: AnyAttemptLoopContext<TRequest, TContext>,
): Response {
  const retained = retainResponseBody(response, ctx.release);
  if (retained !== response) ctx.deferRelease();
  return retained;
}
