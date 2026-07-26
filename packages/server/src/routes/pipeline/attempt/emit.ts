import {
  attributeName,
  type RequestTraceFinishInput,
  type RequestTraceSession,
  spanName,
} from '../../../request-tracing';
import type { UsageCompletion } from '../../../usage-capture';
import type { AttemptInfo } from '../attempt-base';
import { completionFinish, completionTerminal } from '../failure';
import type { AttemptLog } from '../logging';
import { type OpenSpan, type SpanTerminal, startPipelineSpan } from '../tracing';

// Shapes a provider attempt into the failure log payload; attempt facts already
// live on the span, so this only layers on the optional status/error codes.
export function attemptLog(base: AttemptInfo, statusCode?: number, errorCode?: string): AttemptLog {
  return {
    ...base,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

export type AttemptEmitter = {
  readonly startAttempt: (base: AttemptInfo, index: number, httpStatus?: number) => OpenSpan;
  readonly emitAttempt: (base: AttemptInfo, index: number, terminal: SpanTerminal) => void;
  readonly settleSuccess: (
    attemptSpan: OpenSpan,
    completion: Promise<UsageCompletion>,
    ids: { readonly providerId: string; readonly modelId: string },
  ) => Promise<RequestTraceFinishInput>;
};

// Binds the attempt-span helpers to one request session so the candidate loop
// can open, settle, and terminate `aio_proxy.provider.attempt` child spans.
export function createAttemptEmitter(session: RequestTraceSession, streamRequested: boolean): AttemptEmitter {
  const startAttempt = (base: AttemptInfo, index: number, httpStatus?: number): OpenSpan =>
    startPipelineSpan(session.rootContext, spanName.attempt, {
      attributes: {
        [attributeName.attemptIndex]: index,
        [attributeName.providerId]: base.providerId,
        [attributeName.providerKind]: base.providerKind,
        [attributeName.genAiResponseModel]: base.modelId,
        [attributeName.stream]: streamRequested,
        ...(base.protocol === undefined ? {} : { [attributeName.targetProtocol]: base.protocol }),
        ...(httpStatus === undefined ? {} : { [attributeName.httpStatusCode]: httpStatus }),
      },
    });
  return {
    startAttempt,
    emitAttempt(base, index, terminal) {
      startAttempt(base, index).end(terminal);
    },
    settleSuccess(attemptSpan, completion, ids) {
      return completion.then((value) => {
        const ttftMs = 'ttftMs' in value ? value.ttftMs : undefined;
        if (ttftMs !== undefined) attemptSpan.span.setAttribute(attributeName.ttftMs, ttftMs);
        attemptSpan.end(completionTerminal(value));
        return completionFinish(value, ids);
      });
    },
  };
}
