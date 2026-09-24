import type { InboundCapability } from '@aio-proxy/core';
import type { UsageRow } from '@aio-proxy/types';
import { type Attributes, SpanKind } from '@opentelemetry/api';

import { capturesRequestPayload } from '../../../../request-logging';
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

function usageAttributes(usage: UsageRow): Attributes {
  const pairs: ReadonlyArray<readonly [string, number | undefined]> = [
    [attributeName.genAiUsageInputTokens, usage.inputTokens],
    [attributeName.genAiUsageOutputTokens, usage.outputTokens],
    [attributeName.genAiUsageCacheReadTokens, usage.cacheReadTokens],
    [attributeName.genAiUsageCacheCreationTokens, usage.cacheWriteTokens],
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
  readonly startAttempt: (base: AttemptInfo, index: number, upstreamStream?: boolean) => OpenSpan;
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
export function createAttemptEmitter({ session, capability, onAttemptEnd }: AttemptEmitterOptions): AttemptEmitter {
  const capturePayload = capturesRequestPayload();
  const startedAt = new WeakMap<OpenSpan, number>();
  const startAttempt = (base: AttemptInfo, index: number, upstreamStream?: boolean): OpenSpan => {
    const span = startPipelineSpan(session.rootContext, `${OPERATION_NAME[capability]} ${base.modelId}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        [attributeName.genAiOperationName]: OPERATION_NAME[capability],
        [attributeName.genAiRequestModel]: base.modelId,
        [attributeName.attemptIndex]: index,
        [attributeName.providerId]: base.providerId,
        [attributeName.providerKind]: base.providerKind,
        ...(upstreamStream === undefined ? {} : { [attributeName.genAiRequestStream]: upstreamStream }),
        ...routingSpanAttributes(base),
        ...(base.transport === undefined ? {} : { [attributeName.transport]: base.transport }),
        [attributeName.sourceProtocol]: base.sourceProtocol,
        ...(base.targetProtocol === undefined ? {} : { [attributeName.targetProtocol]: base.targetProtocol }),
        ...(base.genAiProviderName === undefined ? {} : { [attributeName.genAiProviderName]: base.genAiProviderName }),
        [attributeName.selectionReason]: base.selectionReason,
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
    if (capturePayload && snapshot.contentEncoding !== undefined) {
      attemptSpan.span.setAttribute(attributeName.contentEncoding, snapshot.contentEncoding);
    }
    if (capturePayload && snapshot.serverAddress !== undefined) {
      attemptSpan.span.setAttribute(attributeName.serverAddress, snapshot.serverAddress);
    }
    if (snapshot.serverPort !== undefined) {
      attemptSpan.span.setAttribute(attributeName.serverPort, snapshot.serverPort);
    }
    if (snapshot.firstContentMs !== undefined) {
      attemptSpan.span.setAttribute(attributeName.genAiTimeToFirstChunk, snapshot.firstContentMs / 1000);
    }
    // How many HTTP sends this one attempt actually made. >1 means same-provider
    // retries happened underneath: raw-retry's hidden replay (at most one), or
    // the AI SDK's maxRetries, which defaults to 2 and that we never set.
    if (snapshot.httpSends !== undefined) {
      attemptSpan.span.setAttribute(attributeName.attemptHttpSends, snapshot.httpSends);
    }
    // Response-side gen_ai.* only exist once the upstream answered, so they land
    // here rather than at span creation. A failed attempt simply omits them.
    if (capturePayload && facts?.responseModelId !== undefined) {
      attemptSpan.span.setAttribute(attributeName.genAiResponseModel, facts.responseModelId);
    }
    if (capturePayload && facts?.responseId !== undefined) {
      attemptSpan.span.setAttribute(attributeName.genAiResponseId, facts.responseId);
    }
    if (facts?.usage !== undefined) {
      attemptSpan.span.setAttributes(usageAttributes(facts.usage));
    }
    const begun = startedAt.get(attemptSpan);
    if (begun !== undefined) onAttemptEnd?.(Math.max(0, performance.now() - begun));
    const { httpStatus: _httpStatus, ...providerTerminal } = terminal;
    attemptSpan.end(providerTerminal);
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
