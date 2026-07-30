import { type ProtocolAdapter, type RouterResolution } from '@aio-proxy/core';
import type { Config } from '@aio-proxy/types';

import type { LogicalSessionResolution } from '../../../logical-session-store';
import { withAttemptLogContext } from '../../../request-logging';
import type { RequestTraceSession } from '../../../request-tracing';
import type { ProviderRouteSource, RuntimeProviderInstance } from '../../../runtime';
import { prioritizeAffinity } from '../affinity';
import { type AttemptLog, logProviderAttemptFailed } from '../logging';
import type { AttemptLoopContext, CandidateSlot, InvocationHolder } from './context';
import { selectLiveCandidates } from './cooldown-write';
import { createAttemptEmitter } from './emit';
import { handleAttemptError, unsupportedDispatch } from './error';
import { attemptModelCandidate } from './model';
import { attemptRawCandidate } from './raw';

type AttemptCandidatesOptions<TRequest, TContext> = {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly candidates: readonly RouterResolution<RuntimeProviderInstance>[];
  readonly context: TContext;
  readonly config: Config | undefined;
  readonly rawRequest: Request;
  readonly request: TRequest;
  readonly requestedModelId: string;
  readonly session: RequestTraceSession;
  readonly source: ProviderRouteSource;
  readonly deferRelease: () => void;
  readonly resolution: LogicalSessionResolution;
  readonly release: () => void;
};

export async function attemptCandidates<TRequest, TContext>(
  options: AttemptCandidatesOptions<TRequest, TContext>,
): Promise<Response> {
  const {
    adapter,
    candidates,
    config,
    context,
    deferRelease,
    resolution,
    rawRequest,
    release,
    request,
    session,
    source,
  } = options;
  const affinityOrdered =
    resolution.affinity?.active === true ? prioritizeAffinity(candidates, resolution.affinity.providerId) : candidates;
  const ordered = prioritizeAffinity(affinityOrdered, resolution.responseOwner?.providerId);
  const weightByProviderId =
    config === undefined ? undefined : new Map(config.providers.map((provider) => [provider.id, provider.weight ?? 0]));
  const retryAfterCapMs = config?.server.retry.retryAfterCapMs ?? 30_000;

  const streamRequested = adapter.wantsStream(request, context);
  const logContext = {
    source,
    requestId: session.requestId,
    rawRequest,
    inboundProtocol: adapter.protocol,
    requestedModelId: options.requestedModelId,
  };
  const ctx: AttemptLoopContext<TRequest, TContext> = {
    adapter,
    context,
    rawRequest,
    request,
    requestedModelId: options.requestedModelId,
    session,
    source,
    logicalRequest: resolution.context,
    sessionIdentity: resolution.identity,
    streamRequested,
    emitter: createAttemptEmitter(session, streamRequested),
    release,
    deferRelease,
    logFailure: (index, attempt: AttemptLog, failureKind, fallback, detail = {}) =>
      logProviderAttemptFailed({ ...logContext, attemptIndex: index, attempt, failureKind, fallback, ...detail }),
    cooldown: source.cooldown,
    retryAfterCapMs,
  };

  const holder: InvocationHolder = { invocation: undefined, invocationUnsupported: undefined };
  let lastFailure: Response | undefined;

  const selection = selectLiveCandidates(ctx.cooldown, ordered);
  if (selection.kind === 'all-cooled') {
    const response = adapter.errors.rateLimited(selection.retryAfterSeconds);
    // Request-level finalization: no provider was attempted, so do NOT use finalFailure
    // (it requires/records a provider+model). Snapshot lease + body cleanup are handled
    // by the outer finally blocks in index.ts.
    session.finish({ outcome: 'failure', finalHttpStatus: 429, errorCode: 'rate_limited' });
    return response;
  }
  const { live } = selection;

  for (const [index, candidate] of live.entries()) {
    const provider = candidate.provider;
    const slot: CandidateSlot = {
      index,
      candidate,
      startedAt: performance.now(),
      hasNext: index < live.length - 1,
      trace: {
        ...(weightByProviderId === undefined ? {} : { providerWeight: weightByProviderId.get(provider.id) ?? 0 }),
        sourceProtocol: adapter.protocol,
        selectionReason:
          resolution.responseOwner?.providerId === provider.id
            ? 'response_owner'
            : resolution.affinity?.active === true && resolution.affinity.providerId === provider.id
              ? 'affinity'
              : 'weight',
      },
      inAttempt: <T>(operation: () => T): T =>
        withAttemptLogContext({ attemptIndex: index, providerId: provider.id, modelId: candidate.modelId }, operation),
      spanRef: { current: undefined },
    };
    try {
      if (provider.raw !== undefined) {
        slot.trace.transport = 'raw';
        slot.trace.targetProtocol = adapter.protocol;
      }
      const raw = provider.raw?.resolve({ protocol: adapter.protocol, modelId: candidate.modelId });
      let step;
      if (raw !== undefined) {
        step = await attemptRawCandidate(ctx, slot, raw);
      } else if (provider.model !== undefined) {
        slot.trace.transport = 'ai_sdk';
        slot.trace.targetProtocol = undefined;
        step = await attemptModelCandidate(ctx, slot, provider.model, holder);
      } else {
        slot.trace.transport = undefined;
        slot.trace.targetProtocol = undefined;
        step = unsupportedDispatch(ctx, slot);
      }
      if (step.kind === 'return') return step.response;
      lastFailure = step.lastFailure;
    } catch (error) {
      const step = handleAttemptError(ctx, slot, error);
      if (step.kind === 'return') return step.response;
      lastFailure = step.lastFailure;
    }
  }

  session.finish({ outcome: 'failure' });
  return lastFailure ?? adapter.errors.unsupported('transform_dispatch');
}
