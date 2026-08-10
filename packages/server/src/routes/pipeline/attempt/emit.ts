import {
  attributeName,
  type RequestTraceFinishInput,
  type RequestTraceSession,
  spanName,
} from '../../../request-tracing';
import type { AttemptResponseObservation } from '../../../response-observation';
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
  readonly endAttempt: (span: OpenSpan, observation: AttemptResponseObservation, terminal: SpanTerminal) => void;
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
        ...(base.providerWeight === undefined ? {} : { [attributeName.providerWeight]: base.providerWeight }),
        ...(base.transport === undefined ? {} : { [attributeName.transport]: base.transport }),
        [attributeName.sourceProtocol]: base.sourceProtocol,
        ...(base.targetProtocol === undefined ? {} : { [attributeName.targetProtocol]: base.targetProtocol }),
        [attributeName.selectionReason]: base.selectionReason,
        ...(httpStatus === undefined ? {} : { [attributeName.httpStatusCode]: httpStatus }),
      },
    });
  const endAttempt = (attemptSpan: OpenSpan, observation: AttemptResponseObservation, terminal: SpanTerminal): void => {
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
        const ttftMs = 'ttftMs' in value ? value.ttftMs : undefined;
        if (ttftMs !== undefined) attemptSpan.span.setAttribute(attributeName.ttftMs, ttftMs);
        endAttempt(attemptSpan, observation, completionTerminal(value));
        return {
          ...completionFinish(value, ids, getResponseId?.()),
          ...(ttftMs === undefined ? {} : { ttftMs }),
          clientResponse,
        };
      });
    },
  };
}
