import type { DashboardTraceSpan, DashboardTraceSummary } from '@aio-proxy/types';

import { traceAttribute, traceSpanName } from '../trace-attribute-names';

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
export const readSpanMetrics = (input: {
  readonly span: DashboardTraceSpan;
  readonly spans: readonly DashboardTraceSpan[];
  readonly trace: DashboardTraceSummary;
}): SpanMetrics => {
  const { span, spans, trace } = input;
  const attributes = span.attributes;
  const isRoot = span.spanId === trace.rootSpanId;
  const attemptCount = spans.filter((candidate) => candidate.name === traceSpanName.attempt).length;

  return {
    httpStatus:
      numberAttribute(attributes, traceAttribute.httpStatusCode) ??
      numberAttribute(attributes, traceAttribute.legacyHttpStatusCode),
    providerId:
      stringAttribute(attributes, traceAttribute.providerId) ??
      stringAttribute(attributes, traceAttribute.finalProviderId) ??
      trace.finalProviderId,
    // attemptModelId 排在前面：新版 attempt span 只有它，新版 GenAI span 只有
    // responseModel，两个都没有的老 span 走后面的链。
    modelId:
      stringAttribute(attributes, traceAttribute.attemptModelId) ??
      stringAttribute(attributes, traceAttribute.responseModel) ??
      stringAttribute(attributes, traceAttribute.requestModel) ??
      trace.finalModelId ??
      trace.requestedModelId,
    durationMs: span.durationMs,
    ttftMs:
      numberAttribute(attributes, traceAttribute.attemptTtftMs) ??
      numberAttribute(attributes, traceAttribute.ttftMs) ??
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
