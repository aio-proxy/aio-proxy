import type { StoredSpan, TraceCompletion } from '@aio-proxy/core/db';
import type { TraceTerminationReason, UsageRow } from '@aio-proxy/types';
import { type Span, SpanStatusCode } from '@opentelemetry/api';

import type { LogicalSessionResolution } from '../../logical-session-store';
import { attributeName } from '../semantic';
import type { RequestTraceFinishInput } from './types';

type IdentityState = {
  readonly requestedModelId: string | undefined;
  readonly resolution: LogicalSessionResolution | undefined;
  readonly mutateSessionState: boolean;
};

export function applyTerminalAttributes(root: Span, finish: RequestTraceFinishInput, identity: IdentityState): void {
  const finalProviderId =
    finish.finalProviderId ??
    (finish.outcome === 'success' && finish.usage !== undefined ? finish.usage.providerId : undefined);
  const finalModelId =
    finish.finalModelId ??
    (finish.outcome === 'success' && finish.usage !== undefined ? finish.usage.modelId : undefined);

  if (finalProviderId !== undefined) root.setAttribute(attributeName.finalProviderId, finalProviderId);
  if (finalModelId !== undefined) root.setAttribute(attributeName.genAiResponseModel, finalModelId);
  if (finish.finalHttpStatus !== undefined) root.setAttribute(attributeName.httpStatusCode, finish.finalHttpStatus);
  if (finish.outcome === 'success' && finish.usage !== undefined) applyUsageAttributes(root, finish.usage);

  if (finish.outcome === 'failure') {
    root.setStatus({ code: SpanStatusCode.ERROR });
    root.setAttribute(attributeName.terminationReason, 'failure' as TraceTerminationReason);
    if (finish.errorType !== undefined) root.setAttribute(attributeName.errorType, finish.errorType);
    if (finish.errorCode !== undefined) root.setAttribute(attributeName.errorCode, finish.errorCode);
  } else if (finish.outcome === 'cancelled') {
    root.setStatus({ code: SpanStatusCode.ERROR });
    root.setAttribute(attributeName.terminationReason, 'cancelled' as TraceTerminationReason);
  }

  if (identity.resolution !== undefined && identity.requestedModelId !== undefined) {
    root.setAttribute(attributeName.genAiRequestModel, identity.requestedModelId);
    root.setAttribute(attributeName.sessionSource, identity.resolution.identity.source);
    root.setAttribute(attributeName.sessionId, identity.resolution.identity.id);
    root.setAttribute(attributeName.sessionResolvedBy, identity.resolution.resolvedBy);
  }
}

function applyUsageAttributes(root: Span, usage: UsageRow): void {
  if (usage.inputTokens !== undefined) root.setAttribute(attributeName.genAiUsageInputTokens, usage.inputTokens);
  if (usage.outputTokens !== undefined) root.setAttribute(attributeName.genAiUsageOutputTokens, usage.outputTokens);
  if (usage.totalTokens !== undefined) root.setAttribute(attributeName.genAiUsageTotalTokens, usage.totalTokens);
  if (usage.cacheReadTokens !== undefined)
    root.setAttribute(attributeName.genAiUsageCacheReadTokens, usage.cacheReadTokens);
  if (usage.cacheWriteTokens !== undefined)
    root.setAttribute(attributeName.genAiUsageCacheWriteTokens, usage.cacheWriteTokens);
  if (usage.reasoningTokens !== undefined)
    root.setAttribute(attributeName.genAiUsageReasoningTokens, usage.reasoningTokens);
}

export function buildCompletion(deps: {
  readonly traceId: string;
  readonly rootSpanId: string;
  readonly spans: StoredSpan[];
  readonly finish: RequestTraceFinishInput;
  readonly identity: IdentityState;
}): TraceCompletion {
  const { finish, identity } = deps;
  const finalProviderId =
    finish.finalProviderId ??
    (finish.outcome === 'success' && finish.usage !== undefined ? finish.usage.providerId : undefined);
  const finalModelId =
    finish.finalModelId ??
    (finish.outcome === 'success' && finish.usage !== undefined ? finish.usage.modelId : undefined);

  const summary: TraceCompletion['summary'] = {
    ...(finalProviderId !== undefined ? { finalProviderId } : {}),
    ...(finalModelId !== undefined ? { finalModelId } : {}),
    ...(finish.finalHttpStatus !== undefined ? { finalHttpStatus: finish.finalHttpStatus } : {}),
    ...(finish.outcome === 'success' && finish.usage !== undefined ? { usage: finish.usage } : {}),
    ...(finish.outcome === 'failure' ? { terminationReason: 'failure' as TraceTerminationReason } : {}),
    ...(finish.outcome === 'failure' && finish.errorType !== undefined ? { errorType: finish.errorType } : {}),
    ...(finish.outcome === 'failure' && finish.errorCode !== undefined ? { errorCode: finish.errorCode } : {}),
    ...(finish.outcome === 'cancelled' ? { terminationReason: 'cancelled' as TraceTerminationReason } : {}),
  };

  return {
    traceId: deps.traceId,
    rootSpanId: deps.rootSpanId,
    spans: deps.spans,
    summary,
    ...(identity.resolution !== undefined && identity.requestedModelId !== undefined
      ? {
          session: {
            identity: identity.resolution.identity,
            requestedModelId: identity.requestedModelId,
            resolvedBy: identity.resolution.resolvedBy,
          },
        }
      : {}),
    ...(identity.mutateSessionState && identity.resolution?.affinity !== undefined
      ? {
          sessionState: {
            observedAffinity: identity.resolution.affinity,
            ...(finish.outcome === 'success' && finish.responseId !== undefined
              ? { responseId: finish.responseId }
              : {}),
          },
        }
      : {}),
  };
}
