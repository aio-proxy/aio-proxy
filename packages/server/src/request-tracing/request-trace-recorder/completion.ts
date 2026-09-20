import type { StoredSpan, TraceCompletion } from '@aio-proxy/core/db';
import type { TraceTerminationReason } from '@aio-proxy/types';
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

  // 纯 HTTP 语义：gen_ai.* 只挂在 GenAI span 上。root 也带一份的话，Langfuse
  // 会把一条 trace 读成两个 GENERATION。root 行的 model / usage 列来自 summary。
  if (finalProviderId !== undefined) root.setAttribute(attributeName.finalProviderId, finalProviderId);
  if (finish.finalHttpStatus !== undefined) root.setAttribute(attributeName.httpStatusCode, finish.finalHttpStatus);
  if (finish.ttftMs !== undefined) root.setAttribute(attributeName.ttftMs, finish.ttftMs);

  if (finish.outcome === 'failure') {
    // HTTP 语义约定：SERVER span 的 4xx 是客户端错误，span status 保持 UNSET。
    // 只有 5xx 和拿不到状态码的内部失败才是服务端错误。DB summary 列照旧全写。
    if (!isClientError(finish.finalHttpStatus)) root.setStatus({ code: SpanStatusCode.ERROR });
    root.setAttribute(attributeName.terminationReason, 'failure' as TraceTerminationReason);
    if (finish.errorType !== undefined) root.setAttribute(attributeName.errorType, finish.errorType);
    if (finish.errorCode !== undefined) root.setAttribute(attributeName.errorCode, finish.errorCode);
  } else if (finish.outcome === 'cancelled') {
    // HTTP 语义约定：调用方主动取消不是错误 —— "the cancellation SHOULD NOT be treated as
    // an error: the span status SHOULD be left unset and `error.type` SHOULD NOT be set"。
    // 客户端断连就是这种取消，所以这里只记终止原因，不置 ERROR。
    // 仪表盘区分取消靠的是 terminationReason（TraceStatus），不是 span status ——
    // completion.test.ts 有断言钉住这一点，别把渲染改回读 span status。
    root.setAttribute(attributeName.terminationReason, 'cancelled' as TraceTerminationReason);
  }

  if (identity.resolution !== undefined && identity.requestedModelId !== undefined) {
    root.setAttribute(attributeName.sessionSource, identity.resolution.identity.source);
    root.setAttribute(attributeName.sessionId, identity.resolution.identity.id);
    root.setAttribute(attributeName.sessionResolvedBy, identity.resolution.resolvedBy);
  }
}

function isClientError(status: number | undefined): boolean {
  return status !== undefined && status >= 400 && status < 500;
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
    ...(identity.mutateSessionState && identity.resolution !== undefined
      ? {
          sessionState: {
            // observedAffinity is undefined on a session's first request; the
            // store treats that as bootstrap and inserts the initial row.
            ...(identity.resolution.affinity !== undefined ? { observedAffinity: identity.resolution.affinity } : {}),
            ...(finish.outcome === 'success' && finish.responseId !== undefined
              ? { responseId: finish.responseId }
              : {}),
          },
        }
      : {}),
  };
}
