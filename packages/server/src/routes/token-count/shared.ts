import { attributeName, type RequestTraceSession, spanName } from '../../request-tracing';
import type { RuntimeProviderInstance } from '../../runtime';
import { type OpenSpan, startPipelineSpan } from '../pipeline/tracing';

// Attempt identity shared by the raw-forward and tokenCount paths.
export type CountAttempt = {
  readonly providerId: string;
  readonly modelId: string;
  readonly providerKind: RuntimeProviderInstance['kind'];
};

export function startAttemptSpan(session: RequestTraceSession, attempt: CountAttempt, index: number): OpenSpan {
  return startPipelineSpan(session.rootContext, spanName.attempt, {
    attributes: {
      [attributeName.attemptIndex]: index,
      [attributeName.providerId]: attempt.providerId,
      [attributeName.providerKind]: attempt.providerKind,
      [attributeName.genAiResponseModel]: attempt.modelId,
    },
  });
}

// Why a resolved candidate was passed over before its count capability ran.
// Each reason maps to a `continue` in countCandidates that would otherwise
// leave no trace, making a later local-estimate fallback unexplained.
export type CandidateSkipReason = 'no_capability' | 'image_unsupported' | 'missing_tool';

// Record a passed-over candidate as a short failure span so the trace shows
// which providers were considered and why the loop advanced. The span carries
// no upstream duration; it exists purely for attribution.
export function recordSkippedCandidate(
  session: RequestTraceSession,
  attempt: CountAttempt,
  index: number,
  reason: CandidateSkipReason,
): void {
  const span = startPipelineSpan(session.rootContext, spanName.candidateSkipped, {
    attributes: {
      [attributeName.attemptIndex]: index,
      [attributeName.providerId]: attempt.providerId,
      [attributeName.providerKind]: attempt.providerKind,
      [attributeName.genAiResponseModel]: attempt.modelId,
      [attributeName.skipReason]: reason,
    },
  });
  span.end({ outcome: 'failure', errorCode: reason });
}

// Record the local-estimate fallback as its own span so a request answered
// without any upstream count is distinguishable from an upstream success. This
// replaces the former `x-aio-proxy-token-count-estimated` response header,
// moving the signal from the client response into the trace.
export function recordLocalEstimate(session: RequestTraceSession): void {
  const span = startPipelineSpan(session.rootContext, spanName.tokenCount, {
    attributes: {
      [attributeName.tokenCountSource]: 'local_estimate',
    },
  });
  span.end();
}

export function throwIfCountAborted(session: RequestTraceSession, signal: AbortSignal): void {
  try {
    signal.throwIfAborted();
  } catch (error) {
    session.finish({ outcome: 'cancelled' });
    throw error;
  }
}
