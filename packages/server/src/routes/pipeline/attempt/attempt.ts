import { type InboundProtocolAdapter, type RouterCandidate } from '@aio-proxy/core';
import type { Config } from '@aio-proxy/types';

import type { LogicalSessionResolution } from '../../../logical-session-store';
import { withAttemptLogContext } from '../../../request-logging';
import type { RequestTraceSession } from '../../../request-tracing';
import { createAttemptResponseObservation, withAttemptResponseObservation } from '../../../response-observation';
import type { ProviderRouteSource, RuntimeProviderInstance } from '../../../runtime';
import { prioritizeAffinity } from '../affinity';
import { candidateRoutingTrace, candidateSelectionSource } from '../attempt-base';
import { type AttemptLog, logProviderAttemptFailed } from '../logging';
import type { AttemptLoopContext, CandidateSlot, InvocationHolder } from './context';
import { selectLiveCandidates } from './cooldown-write';
import { createAttemptEmitter } from './emit';
import { handleAttemptError, unsupportedDispatch } from './error';
import { dispatchImageCandidate } from './image';
import { attemptModelCandidate } from './model';
import { attemptRawCandidate } from './raw';

type AttemptCandidatesOptions<TRequest, TContext> = {
  readonly adapter: InboundProtocolAdapter<TRequest, TContext>;
  readonly candidates: readonly RouterCandidate<RuntimeProviderInstance>[];
  readonly context: TContext;
  readonly config: Config | undefined;
  readonly rawRequest: Request;
  readonly request: TRequest;
  readonly requestedModelId: string;
  readonly session: RequestTraceSession;
  readonly source: ProviderRouteSource;
  readonly streamRequested: boolean;
  readonly deferRelease: () => void;
  readonly resolution: LogicalSessionResolution;
  readonly release: () => void;
};

function createAttemptLoopContext<TRequest, TContext>(
  options: AttemptCandidatesOptions<TRequest, TContext>,
): AttemptLoopContext<TRequest, TContext> {
  const {
    adapter,
    config,
    context,
    deferRelease,
    rawRequest,
    release,
    request,
    requestedModelId,
    resolution,
    session,
    source,
    streamRequested,
  } = options;
  const logContext = {
    source,
    requestId: session.requestId,
    rawRequest,
    inboundProtocol: adapter.protocol,
    requestedModelId,
  };
  return {
    adapter,
    context,
    rawRequest,
    request,
    requestedModelId,
    session,
    source,
    logicalRequest: resolution.context,
    routingContinuity: {
      ...(resolution.affinity === undefined ? {} : { observedAffinity: resolution.affinity }),
      ...(resolution.responseOwner === undefined
        ? {}
        : { responseOwnerProviderId: resolution.responseOwner.providerId }),
      updatesAffinity: resolution.resolvedBy !== 'generated',
    },
    sessionIdentity: resolution.identity,
    streamRequested,
    emitter: createAttemptEmitter(session, streamRequested),
    release,
    deferRelease,
    logFailure: (index, attempt: AttemptLog, failureKind, fallback, detail = {}) =>
      logProviderAttemptFailed({ ...logContext, attemptIndex: index, attempt, failureKind, fallback, ...detail }),
    cooldown: source.cooldown,
    retryAfterCapMs: config?.server.retry.retryAfterCapMs ?? 30_000,
  };
}

export async function attemptCandidates<TRequest, TContext>(
  options: AttemptCandidatesOptions<TRequest, TContext>,
): Promise<Response> {
  const { adapter, candidates, resolution, session } = options;
  const affinityOrdered =
    resolution.affinity?.active === true ? prioritizeAffinity(candidates, resolution.affinity.providerId) : candidates;
  const ordered = prioritizeAffinity(affinityOrdered, resolution.responseOwner?.providerId);
  const ctx = createAttemptLoopContext(options);

  const holder: InvocationHolder = { invocation: undefined, invocationUnsupported: undefined };
  let lastFailure: Response | undefined;
  let lastSkipReason: string | undefined;

  const selection = selectLiveCandidates(ctx.cooldown, ordered);
  if (selection.kind === 'all-cooled') {
    const response = adapter.errors.rateLimited(selection.retryAfterSeconds);
    // Request-level finalization: no provider was attempted, so do NOT use finalFailure
    // (it requires/records a provider+model). Snapshot lease + body cleanup are handled
    // by the outer finally blocks in index.ts.
    session.finish({
      outcome: 'failure',
      finalHttpStatus: 429,
      errorCode: 'rate_limited',
      clientResponse: response,
    });
    return response;
  }
  const { live } = selection;

  for (const [index, candidate] of live.entries()) {
    const provider = candidate.provider;
    const startedAt = performance.now();
    const observation = createAttemptResponseObservation({ startedAt });
    let selectionReason: CandidateSlot['trace']['selectionReason'] = 'weight';
    if (resolution.affinity?.active === true && resolution.affinity.providerId === provider.id)
      selectionReason = 'affinity';
    if (resolution.responseOwner?.providerId === provider.id) selectionReason = 'response_owner';
    const slot: CandidateSlot = {
      index,
      candidate,
      startedAt,
      observation,
      hasNext: index < live.length - 1,
      trace: {
        ...candidateRoutingTrace(candidate, candidateSelectionSource(candidate, resolution)),
        sourceProtocol: adapter.protocol,
        selectionReason,
      },
      inAttempt: <T>(targetProtocol: CandidateSlot['trace']['targetProtocol'], operation: () => T): T =>
        withAttemptResponseObservation(observation, () =>
          withAttemptLogContext(
            {
              attemptIndex: index,
              providerId: provider.id,
              modelId: candidate.modelId,
              requestedModelId: options.requestedModelId,
              sourceProtocol: adapter.protocol,
              ...(targetProtocol === undefined ? {} : { targetProtocol }),
            },
            operation,
          ),
        ),
      spanRef: { current: undefined },
    };
    try {
      let step;
      if (adapter.capability === 'image') {
        step = await dispatchImageCandidate(ctx, slot);
      } else {
        if (provider.raw !== undefined) {
          slot.trace.transport = 'raw';
          slot.trace.targetProtocol = adapter.protocol;
        }
        const raw = provider.raw?.resolve({ protocol: adapter.protocol, modelId: candidate.modelId });
        if (raw !== undefined) {
          step = await attemptRawCandidate(ctx, slot, raw);
        } else if (adapter.capability === 'language' && provider.model !== undefined) {
          slot.trace.transport = 'ai_sdk';
          slot.trace.targetProtocol = undefined;
          step = await attemptModelCandidate({ ...ctx, adapter }, slot, provider.model, holder);
        } else {
          slot.trace.transport = undefined;
          slot.trace.targetProtocol = undefined;
          step = unsupportedDispatch(ctx, slot);
        }
      }
      if (step.kind === 'return') return step.response;
      if (step.kind === 'skip') {
        lastSkipReason = step.reason;
        continue;
      }
      lastFailure = step.lastFailure;
    } catch (error) {
      const step = handleAttemptError(ctx, slot, error);
      if (step.kind === 'return') return step.response;
      if (step.kind === 'skip') {
        lastSkipReason = step.reason;
        continue;
      }
      lastFailure = step.lastFailure;
    }
  }

  const response =
    lastFailure ?? adapter.errors.unsupported(lastSkipReason === undefined ? 'transform_dispatch' : lastSkipReason);
  session.finish({ outcome: 'failure', finalHttpStatus: response.status, clientResponse: response });
  return response;
}
