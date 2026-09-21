import type { InboundCapability } from '@aio-proxy/core';
import { ProviderProtocol, type UsageRow } from '@aio-proxy/types';
import { type Attributes, SpanKind } from '@opentelemetry/api';

import { attributeName, type RequestTraceFinishInput, type RequestTraceSession } from '../../../../request-tracing';
import type { AttemptResponseObservation } from '../../../../response-observation';
import type { UsageCompletion } from '../../../../usage-capture';
import { type AttemptInfo, routingSpanAttributes } from '../../attempt-base';
import { completionFinish, completionTerminal } from '../../failure';
import type { AttemptLog } from '../../logging';
import { type OpenSpan, type SpanTerminal, startPipelineSpan } from '../../tracing';

// Span-name verb and gen_ai.operation.name per capability. The enum is open
// ("otherwise, a custom value MAY be used") and the attribute is Required on an
// inference span, so every inbound capability gets a value rather than only the
// two predefined ones. If upstream later defines values for the custom verbs,
// rename to match.
const OPERATION_NAME: Record<InboundCapability, string> = {
  language: 'chat',
  embedding: 'embeddings',
  image: 'image_generation',
  speech: 'speech',
  transcription: 'transcription',
  video: 'video_generation',
  evaluation: 'evaluation',
};

// gen_ai.provider.name discriminates the telemetry FORMAT flavour, not our
// provider id: the convention says it "may differ from the actual upstream
// provider ... configured against a proxy". So it maps from the wire protocol we
// actually spoke -- an openai-compatible upstream emits OpenAI-shaped telemetry
// whoever runs it. Our own key stays on aio_proxy.attempt.provider_id.
//
// Attached alongside aio_proxy.protocol.target: at span creation when the
// protocol is already known (raw passthrough), or later in attempt/model.ts
// after prepare resolves it. A protocol we cannot name leaves the attribute
// off -- it is an aggregation discriminator, so a wrong value is worse than
// a missing one.
const PROVIDER_NAME: Record<ProviderProtocol, string | undefined> = {
  [ProviderProtocol.Anthropic]: 'anthropic',
  [ProviderProtocol.OpenAIResponse]: 'openai',
  [ProviderProtocol.OpenAICompatible]: 'openai',
  [ProviderProtocol.OpenAIImage]: 'openai',
  [ProviderProtocol.OpenAIAudio]: 'openai',
  [ProviderProtocol.OpenAIVideo]: 'openai',
  [ProviderProtocol.Gemini]: 'gcp.gemini',
  [ProviderProtocol.GeminiInteractions]: 'gcp.gemini',
  // System One is not a well-known telemetry flavour. Naming it `openai` (or
  // anything else) would mix evaluation hops into another vendor's series.
  [ProviderProtocol.TypeSafeSystemOne]: undefined,
};

// Exported so attempt/model.ts can attach it after prepare, the first moment
// the protocol is known on the model path.
export function genAiProviderNameFor(protocol: ProviderProtocol): string | undefined {
  return PROVIDER_NAME[protocol];
}

function usageAttributes(usage: UsageRow): Attributes {
  const pairs: ReadonlyArray<readonly [string, number | undefined]> = [
    [attributeName.genAiUsageInputTokens, usage.inputTokens],
    [attributeName.genAiUsageOutputTokens, usage.outputTokens],
    [attributeName.genAiUsageTotalTokens, usage.totalTokens],
    [attributeName.genAiUsageCacheReadTokens, usage.cacheReadTokens],
    [attributeName.genAiUsageCacheWriteTokens, usage.cacheWriteTokens],
    [attributeName.genAiUsageReasoningTokens, usage.reasoningTokens],
  ];
  return Object.fromEntries(pairs.filter(([, value]) => value !== undefined));
}

// Shapes a provider attempt into the failure log payload; attempt facts already
// live on the span, so this only layers on the optional status/error codes.
export function attemptLog(base: AttemptInfo, statusCode?: number, errorCode?: string): AttemptLog {
  return {
    ...base,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

// What an ending attempt knows about the response, when it succeeded. Failed
// attempts pass nothing and simply omit the response-side gen_ai.* attributes.
export type AttemptOutcomeFacts = {
  readonly usage?: UsageRow;
  readonly responseModelId?: string;
  readonly responseId?: string;
};

export type AttemptEmitter = {
  readonly startAttempt: (base: AttemptInfo, index: number, httpStatus?: number) => OpenSpan;
  readonly endAttempt: (
    span: OpenSpan,
    observation: AttemptResponseObservation,
    terminal: SpanTerminal,
    facts?: AttemptOutcomeFacts,
  ) => void;
  readonly emitAttempt: (
    base: AttemptInfo,
    index: number,
    observation: AttemptResponseObservation,
    terminal: SpanTerminal,
  ) => void;
  readonly settleSuccess: (
    attemptSpan: OpenSpan,
    observation: AttemptResponseObservation,
    completion: Promise<UsageCompletion>,
    ids: { readonly providerId: string; readonly modelId: string },
    clientResponse: Response,
    getResponseId?: () => string | undefined,
  ) => Promise<RequestTraceFinishInput>;
};

export type AttemptEmitterOptions = {
  readonly session: RequestTraceSession;
  readonly streamRequested: boolean;
  readonly capability: InboundCapability;
  // Reports each finished attempt's duration up to the logical-operation layer,
  // which uses it for aio_proxy.inference.attempt_count / failover_ms.
  readonly onAttemptEnd?: (durationMs: number) => void;
};

// Binds the attempt-span helpers to one request session. Each attempt is a real
// inference span: CLIENT kind, named `{operation} {model}`, carrying the gen_ai.*
// facts of the ONE upstream it talked to. Same-provider backoff retries stay
// inside a single span and show up as several POST children -- the convention
// says a span "SHOULD cover the duration of the logical operation with all
// retries", and a retry is the same call, whereas a different provider is not.
export function createAttemptEmitter({
  session,
  streamRequested,
  capability,
  onAttemptEnd,
}: AttemptEmitterOptions): AttemptEmitter {
  const startedAt = new WeakMap<OpenSpan, number>();
  const startAttempt = (base: AttemptInfo, index: number, httpStatus?: number): OpenSpan => {
    const providerName = base.targetProtocol === undefined ? undefined : genAiProviderNameFor(base.targetProtocol);
    const span = startPipelineSpan(session.rootContext, `${OPERATION_NAME[capability]} ${base.modelId}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        [attributeName.genAiOperationName]: OPERATION_NAME[capability],
        [attributeName.genAiRequestModel]: base.modelId,
        [attributeName.attemptIndex]: index,
        [attributeName.providerId]: base.providerId,
        [attributeName.providerKind]: base.providerKind,
        [attributeName.attemptModelId]: base.modelId,
        [attributeName.stream]: streamRequested,
        ...routingSpanAttributes(base),
        ...(base.transport === undefined ? {} : { [attributeName.transport]: base.transport }),
        [attributeName.sourceProtocol]: base.sourceProtocol,
        ...(base.targetProtocol === undefined ? {} : { [attributeName.targetProtocol]: base.targetProtocol }),
        ...(providerName === undefined ? {} : { [attributeName.genAiProviderName]: providerName }),
        [attributeName.selectionReason]: base.selectionReason,
        ...(httpStatus === undefined ? {} : { [attributeName.httpStatusCode]: httpStatus }),
      },
    });
    startedAt.set(span, performance.now());
    return span;
  };
  const endAttempt = (
    attemptSpan: OpenSpan,
    observation: AttemptResponseObservation,
    terminal: SpanTerminal,
    facts?: AttemptOutcomeFacts,
  ): void => {
    const snapshot = observation.snapshot();
    if (snapshot.transportObservation !== undefined) {
      attemptSpan.span.setAttribute(attributeName.transportObservation, snapshot.transportObservation);
    }
    if (snapshot.upstreamHeadersMs !== undefined) {
      attemptSpan.span.setAttribute(attributeName.upstreamHeadersMs, snapshot.upstreamHeadersMs);
    }
    if (snapshot.firstUpstreamByteMs !== undefined) {
      attemptSpan.span.setAttribute(attributeName.firstUpstreamByteMs, snapshot.firstUpstreamByteMs);
    }
    if (snapshot.firstSseEventMs !== undefined) {
      attemptSpan.span.setAttribute(attributeName.firstSseEventMs, snapshot.firstSseEventMs);
    }
    if (snapshot.contentGapP95Ms !== undefined) {
      attemptSpan.span.setAttribute(attributeName.contentGapP95Ms, snapshot.contentGapP95Ms);
    }
    if (snapshot.maxSseFramesPerRead !== undefined) {
      attemptSpan.span.setAttribute(attributeName.maxSseFramesPerRead, snapshot.maxSseFramesPerRead);
    }
    if (snapshot.contentEncoding !== undefined) {
      attemptSpan.span.setAttribute(attributeName.contentEncoding, snapshot.contentEncoding);
    }
    if (snapshot.firstContentMs !== undefined) {
      attemptSpan.span.setAttribute(attributeName.attemptTtftMs, snapshot.firstContentMs);
    }
    // How many HTTP sends this one attempt actually made. >1 means same-provider
    // retries happened underneath: raw-retry's hidden replay (at most one), or
    // the AI SDK's maxRetries, which defaults to 2 and that we never set.
    if (snapshot.httpSends !== undefined) {
      attemptSpan.span.setAttribute(attributeName.attemptHttpSends, snapshot.httpSends);
    }
    // Response-side gen_ai.* only exist once the upstream answered, so they land
    // here rather than at span creation. A failed attempt simply omits them.
    if (facts?.responseModelId !== undefined) {
      attemptSpan.span.setAttribute(attributeName.genAiResponseModel, facts.responseModelId);
    }
    if (facts?.responseId !== undefined) {
      attemptSpan.span.setAttribute(attributeName.genAiResponseId, facts.responseId);
    }
    if (facts?.usage !== undefined) {
      attemptSpan.span.setAttributes(usageAttributes(facts.usage));
    }
    const begun = startedAt.get(attemptSpan);
    if (begun !== undefined) onAttemptEnd?.(Math.max(0, performance.now() - begun));
    attemptSpan.end(terminal);
  };
  return {
    startAttempt,
    endAttempt,
    emitAttempt(base, index, observation, terminal) {
      endAttempt(startAttempt(base, index), observation, terminal);
    },
    settleSuccess(attemptSpan, observation, completion, ids, clientResponse, getResponseId) {
      return completion.then((value) => {
        // attempt span 的 TTFT 由 endAttempt 从 observation 统一落，这里只负责 root/DB 的那份。
        const ttftMs = 'ttftMs' in value ? value.ttftMs : undefined;
        const responseId = getResponseId?.();
        const finish = completionFinish(value, ids, responseId);
        endAttempt(attemptSpan, observation, completionTerminal(value), {
          ...(value.outcome === 'success' && value.usage !== undefined ? { usage: value.usage } : {}),
          ...(finish.finalModelId === undefined ? {} : { responseModelId: finish.finalModelId }),
          ...(responseId === undefined ? {} : { responseId }),
        });
        return {
          ...finish,
          ...(ttftMs === undefined ? {} : { ttftMs }),
          ...(value.firstChunkAt === undefined ? {} : { firstChunkAt: value.firstChunkAt }),
          clientResponse,
        };
      });
    },
  };
}
