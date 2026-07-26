import { type ProtocolAdapter, type RouterResolution } from '@aio-proxy/core';
import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';

import { withAttemptLogContext } from '../../request-logging';
import type { RequestSession } from '../../request-recorder';
import type { ProviderRouteSource, RuntimeProviderInstance } from '../../runtime';
import { attemptRawProvider, handleAttemptError, unsupportedDispatch } from './attempt-candidate';
import type { AttemptContext, CandidateAttempt, InvocationState } from './attempt-context';
import { attemptModelProvider } from './attempt-model';
import { logProviderAttemptFailed } from './logging';

type AttemptCandidatesOptions<TRequest, TContext> = {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly candidates: readonly RouterResolution<RuntimeProviderInstance>[];
  readonly context: TContext;
  readonly rawRequest: Request;
  readonly request: TRequest;
  readonly requestedModelId: string;
  readonly session: RequestSession;
  readonly source: ProviderRouteSource;
  readonly deferRelease: () => void;
  readonly logicalRequest: LogicalRequestContext;
  readonly release: () => void;
};

export async function attemptCandidates<TRequest, TContext>({
  adapter,
  candidates,
  context,
  deferRelease,
  logicalRequest,
  rawRequest,
  release,
  request,
  requestedModelId,
  session,
  source,
}: AttemptCandidatesOptions<TRequest, TContext>): Promise<Response> {
  const invocationState: InvocationState = { invocation: undefined, invocationUnsupported: undefined };
  let lastFailure: Response | undefined;
  const failureLogContext = { source, session, rawRequest, inboundProtocol: adapter.protocol, requestedModelId };
  const ctx: AttemptContext<TRequest, TContext> = {
    adapter,
    context,
    rawRequest,
    request,
    requestedModelId,
    session,
    source,
    logicalRequest,
    release,
    deferRelease,
    logFailure: (attemptIndex, attempt, failureKind, fallback, detail = {}) =>
      logProviderAttemptFailed({ ...failureLogContext, attemptIndex, attempt, failureKind, fallback, ...detail }),
  };

  for (const [index, candidate] of candidates.entries()) {
    const provider = candidate.provider;
    const slot: CandidateAttempt = {
      index,
      candidate,
      startedAt: performance.now(),
      hasNext: index < candidates.length - 1,
      inAttempt: (operation) =>
        withAttemptLogContext({ attemptIndex: index, providerId: provider.id, modelId: candidate.modelId }, operation),
    };
    try {
      const raw = provider.raw?.resolve({ protocol: adapter.protocol, modelId: candidate.modelId });
      const outcome =
        raw !== undefined
          ? await attemptRawProvider(ctx, slot, raw)
          : provider.model !== undefined
            ? await attemptModelProvider(ctx, slot, provider.model, invocationState)
            : unsupportedDispatch(ctx, slot);
      if (outcome.kind === 'return') return outcome.response;
      lastFailure = outcome.lastFailure;
    } catch (error) {
      const outcome = handleAttemptError(ctx, slot, error);
      if (outcome.kind === 'return') return outcome.response;
      lastFailure = outcome.lastFailure;
    }
  }

  session.finish({ outcome: 'failure' });
  return lastFailure ?? adapter.errors.unsupported('transform_dispatch');
}
