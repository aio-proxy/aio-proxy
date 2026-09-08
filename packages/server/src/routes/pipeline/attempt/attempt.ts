import type {
  AnyProtocolAdapter,
  AudioProtocolAdapter,
  ImageProtocolAdapter,
  RouterCandidate,
  VideoProtocolAdapter,
} from '@aio-proxy/core';
import type { Config } from '@aio-proxy/types';

import type { LogicalSessionResolution } from '../../../logical-session-store';
import { withAttemptLogContext } from '../../../request-logging';
import type { RequestTraceSession } from '../../../request-tracing';
import { createAttemptResponseObservation, withAttemptResponseObservation } from '../../../response-observation';
import type { ProviderRouteSource, RuntimeProviderInstance } from '../../../runtime';
import { prioritizeAffinity } from '../affinity';
import { candidateRoutingTrace, candidateSelectionSource } from '../attempt-base';
import { type AttemptLog, logProviderAttemptFailed } from '../logging';
import { attemptAudioCandidate } from './audio';
import type {
  AnyAttemptLoopContext,
  AttemptLoopContext,
  AttemptStep,
  AudioAttemptLoopContext,
  CandidateSlot,
  EmbeddingAttemptLoopContext,
  ImageAttemptLoopContext,
  InvocationHolder,
  VideoAttemptLoopContext,
} from './context';
import { selectLiveCandidates } from './cooldown-write';
import { attemptEmbeddingCandidate } from './embedding';
import { createAttemptEmitter } from './emit';
import { emitReject, handleAttemptError, unsupportedDispatch } from './error';
import { dispatchImageCandidate } from './image';
import { attemptModelCandidate } from './model';
import { attemptRawCandidate } from './raw';
import { requestPathProperty } from './request-path';
import { warmProviderQuota } from './warm-quota';

type AttemptCandidatesOptions<TRequest, TContext> = {
  readonly adapter:
    | AnyProtocolAdapter<TRequest, TContext>
    | ImageProtocolAdapter<TRequest, TContext>
    | AudioProtocolAdapter<TRequest, TContext>
    | VideoProtocolAdapter<TRequest, TContext>;
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
  readonly onSuccessfulAttempt?: (info: {
    readonly provider: RuntimeProviderInstance;
    readonly modelId: string;
    readonly response: Response;
  }) => void | Promise<void>;
};

function createAttemptLoopContext<TRequest, TContext>(
  options: AttemptCandidatesOptions<TRequest, TContext>,
): AnyAttemptLoopContext<TRequest, TContext> {
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
    routerModels: options.config?.router.models,
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

type AttemptDispatch<TRequest, TContext> =
  | { readonly kind: 'embedding'; readonly ctx: EmbeddingAttemptLoopContext<TRequest, TContext> }
  | { readonly kind: 'image'; readonly ctx: ImageAttemptLoopContext<TRequest, TContext> }
  | { readonly kind: 'video'; readonly ctx: VideoAttemptLoopContext<TRequest, TContext> }
  | { readonly kind: 'audio'; readonly ctx: AudioAttemptLoopContext<TRequest, TContext> }
  | { readonly kind: 'language'; readonly ctx: AttemptLoopContext<TRequest, TContext> };

// The inbound capability, not the provider kind, decides which transports a
// candidate may use. Resolved once per request so the loop below stays one loop.
// Narrows on the `capability` discriminant directly: the isEmbeddingProtocolAdapter
// guard cannot eliminate union members here because its type parameters infer as
// `unknown` against generic TRequest/TContext.
//
// Every branch tests positively and audio is the fallthrough. Audio is the one
// member whose `capability` is a union (`'speech' | 'transcription'`) rather than a
// single literal, so it is not a discriminant TypeScript can narrow *away* from:
// excluding both of its values still leaves `AudioProtocolAdapter` in the union.
// Testing `=== 'language'` narrows to the member that does carry a single literal,
// which removes audio by elimination.
async function dispatchCandidate<TRequest, TContext>(
  dispatch: AttemptDispatch<TRequest, TContext>,
  slot: CandidateSlot,
  holder: InvocationHolder,
): Promise<AttemptStep> {
  switch (dispatch.kind) {
    case 'embedding':
      return await attemptEmbeddingCandidate(dispatch.ctx, slot);
    case 'image':
      return await dispatchImageCandidate(dispatch.ctx, slot);
    case 'video':
      return await attemptVideoCandidate(dispatch.ctx, slot);
    case 'audio':
      return await attemptAudioCandidate(dispatch.ctx, slot);
    case 'language':
      return await attemptLanguageCandidate(dispatch.ctx, slot, holder);
    default:
      return assertNever(dispatch);
  }
}

function attemptDispatch<TRequest, TContext>(
  ctx: AnyAttemptLoopContext<TRequest, TContext>,
): AttemptDispatch<TRequest, TContext> {
  const { adapter } = ctx;
  if (adapter.capability === 'embedding') return { kind: 'embedding', ctx: { ...ctx, adapter } };
  if (adapter.capability === 'image') return { kind: 'image', ctx: { ...ctx, adapter } };
  if (adapter.capability === 'video') return { kind: 'video', ctx: { ...ctx, adapter } };
  if (adapter.capability === 'language') return { kind: 'language', ctx: { ...ctx, adapter } };
  return { kind: 'audio', ctx: { ...ctx, adapter } };
}

async function attemptVideoCandidate<TRequest, TContext>(
  ctx: VideoAttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
): Promise<AttemptStep> {
  const raw = slot.candidate.provider.raw?.resolve({
    protocol: ctx.adapter.protocol,
    modelId: slot.candidate.modelId,
    ...requestPathProperty(ctx.rawRequest),
  });
  if (raw !== undefined) {
    slot.trace.transport = 'raw';
    slot.trace.targetProtocol = ctx.adapter.protocol;
    return await attemptRawCandidate(ctx, slot, raw);
  }
  slot.trace.transport = undefined;
  slot.trace.targetProtocol = undefined;
  const feature = ctx.adapter.convertSkipReason?.(ctx.request, slot.candidate.modelId) ?? 'video_convert';
  return emitReject(ctx, slot, ctx.adapter.errors.unsupported(feature));
}

// Same-protocol raw wins, then the AI SDK model transport, then nothing.
async function attemptLanguageCandidate<TRequest, TContext>(
  ctx: AttemptLoopContext<TRequest, TContext>,
  slot: CandidateSlot,
  holder: InvocationHolder,
): Promise<AttemptStep> {
  const provider = slot.candidate.provider;
  if (provider.raw !== undefined) {
    slot.trace.transport = 'raw';
    slot.trace.targetProtocol = ctx.adapter.protocol;
  }
  const raw = provider.raw?.resolve({
    protocol: ctx.adapter.protocol,
    modelId: slot.candidate.modelId,
    ...requestPathProperty(ctx.rawRequest),
  });
  if (raw !== undefined) return await attemptRawCandidate(ctx, slot, raw);
  if (provider.model !== undefined) {
    slot.trace.transport = 'ai_sdk';
    slot.trace.targetProtocol = undefined;
    return await attemptModelCandidate(ctx, slot, provider.model, holder);
  }
  slot.trace.transport = undefined;
  slot.trace.targetProtocol = undefined;
  return unsupportedDispatch(ctx, slot);
}

export async function attemptCandidates<TRequest, TContext>(
  options: AttemptCandidatesOptions<TRequest, TContext>,
): Promise<Response> {
  const { adapter, candidates, resolution, session } = options;
  const affinityOrdered =
    resolution.affinity?.active === true ? prioritizeAffinity(candidates, resolution.affinity.providerId) : candidates;
  const ordered = prioritizeAffinity(affinityOrdered, resolution.responseOwner?.providerId);
  const ctx = createAttemptLoopContext(options);
  const dispatch = attemptDispatch(ctx);

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
      const step = await dispatchCandidate(dispatch, slot, holder);
      if (step.kind === 'return') {
        if (options.onSuccessfulAttempt !== undefined && step.response.ok) {
          try {
            await options.onSuccessfulAttempt({
              provider,
              modelId: candidate.modelId,
              response: step.response,
            });
          } catch {
            // Pin failure must not replace a 2xx; the hook logs video.job_pin_failed.
          }
        }
        return warmProviderQuota(options.source, provider, step.response);
      }
      if (step.kind === 'skip') {
        lastSkipReason = step.reason;
        continue;
      }
      lastFailure = step.lastFailure;
    } catch (error) {
      const step = handleAttemptError(ctx, slot, error);
      if (step.kind === 'return') {
        return warmProviderQuota(options.source, provider, step.response);
      }
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

function assertNever(value: never): never {
  throw new Error(`Unsupported attempt dispatch: ${JSON.stringify(value)}`);
}
