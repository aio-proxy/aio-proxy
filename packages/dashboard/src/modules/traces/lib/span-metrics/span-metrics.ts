import type { DashboardTraceSpan, DashboardTraceSummary } from '@aio-proxy/types';

import { isAttemptSpan, traceAttribute } from '../trace-attribute-names';

export interface SpanMetrics {
  readonly httpStatus: number | undefined;
  readonly providerId: string | undefined;
  readonly modelId: string | undefined;
  readonly durationMs: number;
  readonly ttftMs: number | undefined;
  readonly transportObservation: string | undefined;
  readonly upstreamMs: number | undefined;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly attemptCount: number | undefined;
}

type SpanAttributes = DashboardTraceSpan['attributes'];

const numberAttribute = (attributes: SpanAttributes, key: string): number | undefined => {
  const value = attributes[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const stringAttribute = (attributes: SpanAttributes, key: string): string | undefined => {
  const value = attributes[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
};

// 推理 span 上的 TTFT 是语义约定里的 `gen_ai.response.time_to_first_chunk`，单位秒；
// 面板的格子统一按毫秒显示，所以在这里换算，而不是让调用方记住哪个 key 是什么单位。
const genAiTtftMs = (attributes: SpanAttributes): number | undefined => {
  const seconds = numberAttribute(attributes, traceAttribute.genAiTimeToFirstChunk);
  return seconds === undefined ? undefined : seconds * 1000;
};

/**
 * Pulls the six panel metrics plus the status-row identifiers out of one span.
 *
 * Request-scoped numbers (TTFT, usage) only fall back to the trace row for the root span:
 * a child span that never recorded them did not inherit the whole request's totals.
 * Provider and model describe the request outcome, so they fall back trace-wide.
 *
 * `httpStatus` never falls back to the trace row: only the root span and attempt spans
 * record a status code, so lending the trace's final code to a parse span would
 * attribute someone else's outcome to it. Spans without one show their OTel status instead.
 * The `??` on it reads the same span's deprecated `http.status_code`, which is a spelling
 * fallback, not a trace fallback.
 */
// 上游 HTTP 的 CLIENT span 自己不带 provider / model —— 它们挂在所属的 attempt 上。没有这一步，
// 兜底链会一路摸到 trace 的**最终成功**身份，于是失败转移里 A 的 429 会被标成 B 的名字和模型。
// 往上找所属 attempt，而不是借用整条链的结论。`seen` 是环保护：父链来自持久化数据，不能假设它无环。
const ancestorAttempt = (
  span: DashboardTraceSpan,
  spans: readonly DashboardTraceSpan[],
): DashboardTraceSpan | undefined => {
  const byId = new Map(spans.map((candidate) => [candidate.spanId, candidate]));
  const seen = new Set([span.spanId]);
  let current = span;
  while (current.parentSpanId !== undefined) {
    const parent = byId.get(current.parentSpanId);
    if (parent === undefined || seen.has(parent.spanId)) return undefined;
    if (isAttemptSpan(parent)) return parent;
    seen.add(parent.spanId);
    current = parent;
  }
  return undefined;
};

export const readSpanMetrics = (input: {
  readonly span: DashboardTraceSpan;
  readonly spans: readonly DashboardTraceSpan[];
  readonly trace: DashboardTraceSummary;
}): SpanMetrics => {
  const { span, spans, trace } = input;
  const attributes = span.attributes;
  const isRoot = span.spanId === trace.rootSpanId;
  const attemptCount = spans.filter(isAttemptSpan).length;
  // 自己就是 attempt 的不用往上找；找到 attempt 祖先的，身份取那一跳的，绝不借整条链的结论。
  const owner = isAttemptSpan(span) ? undefined : ancestorAttempt(span, spans);
  const ownerAttributes = owner?.attributes;

  return {
    httpStatus:
      numberAttribute(attributes, traceAttribute.httpStatusCode) ??
      numberAttribute(attributes, traceAttribute.legacyHttpStatusCode),
    providerId:
      stringAttribute(attributes, traceAttribute.providerId) ??
      (ownerAttributes === undefined
        ? (stringAttribute(attributes, traceAttribute.finalProviderId) ?? trace.finalProviderId)
        : stringAttribute(ownerAttributes, traceAttribute.providerId)),
    // attemptModelId 排在前面：新版 attempt span 只有它，新版 GenAI span 只有
    // responseModel，两个都没有的老 span 走后面的链。
    modelId:
      stringAttribute(attributes, traceAttribute.attemptModelId) ??
      stringAttribute(attributes, traceAttribute.responseModel) ??
      stringAttribute(attributes, traceAttribute.requestModel) ??
      (ownerAttributes === undefined
        ? (trace.finalModelId ?? trace.requestedModelId)
        : (stringAttribute(ownerAttributes, traceAttribute.attemptModelId) ??
          stringAttribute(ownerAttributes, traceAttribute.responseModel))),
    durationMs: span.durationMs,
    ttftMs:
      numberAttribute(attributes, traceAttribute.attemptTtftMs) ??
      numberAttribute(attributes, traceAttribute.ttftMs) ??
      // 推理 span 的 TTFT 走语义约定的 key，单位是**秒**（`inferenceAttributes` 除了 1000）。
      // 少了这一条，选中那条 span 时 TTFT 格子是「—」，而它明明记了这个数。
      genAiTtftMs(attributes) ??
      (isRoot ? trace.ttftMs : undefined),
    transportObservation: stringAttribute(attributes, traceAttribute.transportObservation),
    upstreamMs: numberAttribute(attributes, traceAttribute.upstreamHeadersMs),
    inputTokens:
      numberAttribute(attributes, traceAttribute.inputTokens) ?? (isRoot ? trace.usage?.inputTokens : undefined),
    outputTokens:
      numberAttribute(attributes, traceAttribute.outputTokens) ?? (isRoot ? trace.usage?.outputTokens : undefined),
    attemptCount: attemptCount === 0 ? undefined : attemptCount,
  };
};
