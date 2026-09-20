import { type Context, type Span, type SpanOptions, SpanStatusCode, context, trace } from '@opentelemetry/api';

import { attributeName, getTraceRuntime } from '../../request-tracing';

export type SpanTerminal = {
  readonly outcome: 'success' | 'failure' | 'cancelled';
  readonly errorType?: string;
  readonly errorCode?: string;
  readonly httpStatus?: number;
};

export type OpenSpan = {
  readonly context: Context;
  readonly span: Span;
  readonly run: <T>(operation: () => T) => T;
  readonly end: (terminal?: SpanTerminal) => void;
};

// Starts a child span under `parent`, exposing an idempotent `end`. Successful
// spans stay UNSET; failure/cancelled carry only controlled attributes (never a
// status message or exception object) so persistence stays allowlist-clean.
export function startPipelineSpan(parent: Context, name: string, options: SpanOptions = {}): OpenSpan {
  const { tracer } = getTraceRuntime();
  const span = tracer.startSpan(name, options, parent);
  const active = trace.setSpan(parent, span);
  let ended = false;
  return {
    context: active,
    span,
    run: (operation) => context.with(active, operation),
    end(terminal) {
      if (ended) return;
      ended = true;
      applySpanTerminal(span, terminal);
      span.end();
    },
  };
}

export function applySpanTerminal(span: Span, terminal?: SpanTerminal): void {
  if (terminal === undefined || terminal.outcome === 'success') return;
  // 调用方主动取消不置 ERROR（http-spans.md：status left unset, error.type not set）。
  // 终止原因照记 —— 区分取消靠它，不靠 span status。root span 那侧同规则，
  // 见 request-trace-recorder/completion.ts。
  if (terminal.outcome !== 'cancelled') span.setStatus({ code: SpanStatusCode.ERROR });
  span.setAttribute(attributeName.terminationReason, terminal.outcome);
  if (terminal.errorType !== undefined) span.setAttribute(attributeName.errorType, terminal.errorType);
  if (terminal.errorCode !== undefined) span.setAttribute(attributeName.errorCode, terminal.errorCode);
  if (terminal.httpStatus !== undefined) span.setAttribute(attributeName.httpStatusCode, terminal.httpStatus);
}
