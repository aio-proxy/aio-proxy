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

export function throwIfCountAborted(session: RequestTraceSession, signal: AbortSignal): void {
  try {
    signal.throwIfAborted();
  } catch (error) {
    session.finish({ outcome: 'cancelled' });
    throw error;
  }
}
