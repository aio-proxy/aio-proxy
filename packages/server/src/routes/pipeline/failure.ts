import type { RequestTraceFinishInput } from '../../request-tracing';
import type { UsageCompletion } from '../../usage-capture';
import type { AttemptInfo } from './attempt-base';
import type { SpanTerminal } from './tracing';

export function shouldFallbackStatus(status: number): boolean {
  return status === 422 || status === 429 || status >= 500;
}

// Terminal, provider-attributed failure. Attempt facts live on the attempt
// span, so the finish input only carries the summary attributes.
export function finalFailure(base: AttemptInfo, statusCode: number, errorCode?: string): RequestTraceFinishInput {
  return {
    outcome: 'failure',
    finalProviderId: base.providerId,
    finalModelId: base.modelId,
    finalHttpStatus: statusCode,
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

export function failureTerminal(statusCode?: number, errorCode?: string): SpanTerminal {
  return {
    outcome: 'failure',
    ...(statusCode === undefined ? {} : { httpStatus: statusCode }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

export function completionTerminal(completion: UsageCompletion): SpanTerminal {
  if (completion.outcome === 'success') return { outcome: 'success' };
  const statusCode = 'statusCode' in completion ? completion.statusCode : undefined;
  const errorCode = completion.outcome === 'failure' ? completion.errorCode : undefined;
  return {
    outcome: completion.outcome,
    ...(statusCode === undefined ? {} : { httpStatus: statusCode }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}

export function completionFinish(
  completion: UsageCompletion,
  ids: { readonly providerId: string; readonly modelId: string },
  responseId?: string,
): RequestTraceFinishInput {
  const statusCode = 'statusCode' in completion ? completion.statusCode : undefined;
  if (completion.outcome === 'success') {
    return {
      outcome: 'success',
      finalProviderId: ids.providerId,
      finalModelId: ids.modelId,
      ...(statusCode === undefined ? {} : { finalHttpStatus: statusCode }),
      ...(completion.usage === undefined ? {} : { usage: completion.usage }),
      ...(responseId === undefined ? {} : { responseId }),
    };
  }
  if (completion.outcome === 'failure') {
    return {
      outcome: 'failure',
      finalProviderId: ids.providerId,
      finalModelId: ids.modelId,
      ...(statusCode === undefined ? {} : { finalHttpStatus: statusCode }),
      ...(completion.errorCode === undefined ? {} : { errorCode: completion.errorCode }),
    };
  }
  return {
    outcome: 'cancelled',
    finalProviderId: ids.providerId,
    finalModelId: ids.modelId,
    ...(statusCode === undefined ? {} : { finalHttpStatus: statusCode }),
  };
}
