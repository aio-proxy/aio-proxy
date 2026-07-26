import { type ProtocolAdapter, type RouterResolution } from '@aio-proxy/core';

import type { LogicalSessionResolution } from '../../../logical-session-store';
import { withAttemptLogContext } from '../../../request-logging';
import type { RequestTraceSession } from '../../../request-tracing';
import type { ProviderRouteSource, RuntimeProviderInstance } from '../../../runtime';
import { prioritizeAffinity } from '../affinity';
import { type AttemptLog, logProviderAttemptFailed } from '../logging';
import type { AttemptLoopContext, CandidateSlot, InvocationHolder } from './context';
import { createAttemptEmitter } from './emit';
import { handleAttemptError, unsupportedDispatch } from './error';
import { attemptModelCandidate } from './model';
import { attemptRawCandidate } from './raw';

type AttemptCandidatesOptions<TRequest, TContext> = {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly candidates: readonly RouterResolution<RuntimeProviderInstance>[];
  readonly context: TContext;
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
  const { adapter, candidates, context, deferRelease, resolution, rawRequest, release, request, session, source } =
    options;
  const ordered =
    resolution.affinity?.active === true ? prioritizeAffinity(candidates, resolution.affinity.providerId) : candidates;

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
  };

  const holder: InvocationHolder = { invocation: undefined, invocationUnsupported: undefined };
  let lastFailure: Response | undefined;

  for (const [index, candidate] of ordered.entries()) {
    const provider = candidate.provider;
    const slot: CandidateSlot = {
      index,
      candidate,
      startedAt: performance.now(),
      hasNext: index < ordered.length - 1,
      inAttempt: <T>(operation: () => T): T =>
        withAttemptLogContext({ attemptIndex: index, providerId: provider.id, modelId: candidate.modelId }, operation),
      spanRef: { current: undefined },
    };
    try {
      const raw = provider.raw?.resolve({ protocol: adapter.protocol, modelId: candidate.modelId });
      const step =
        raw !== undefined
          ? await attemptRawCandidate(ctx, slot, raw)
          : provider.model !== undefined
            ? await attemptModelCandidate(ctx, slot, provider.model, holder)
            : unsupportedDispatch(ctx, slot);
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
