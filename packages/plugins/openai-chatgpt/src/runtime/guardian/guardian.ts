import type { Logger, LogicalRequestContext, RawTransport, RawTransportOptions } from '@aio-proxy/plugin-sdk';

import type { ChatGPTPluginOptions } from '../../plugin-options';
import { guardianDecision } from './decision';
import { guardianQuestions } from './questions';
import { projectGuardianRequest } from './request';
import { guardianResponse } from './response';

type GuardianSystemOneBody = {
  readonly model: string;
  readonly state: { readonly input: readonly unknown[]; readonly pending_action: Record<string, unknown> };
  readonly questions: ReturnType<typeof guardianQuestions>;
};
export type GuardianEvaluate = (input: {
  readonly providerId: string;
  readonly modelId: string;
  readonly body: unknown;
  readonly signal: AbortSignal;
  readonly logicalRequest: LogicalRequestContext;
}) => Promise<unknown>;

type InvocationOptions = RawTransportOptions & {
  readonly __aioGuardianInvocation?: { originalTransportStarted: boolean; syntheticGuardianResponse: boolean };
};

type GuardianEvaluationInput = {
  readonly pluginOptions: Partial<ChatGPTPluginOptions>;
  readonly evaluate?: GuardianEvaluate;
  readonly timeoutSignal?: (milliseconds: number) => AbortSignal;
  readonly logger?: Pick<Logger, 'info'>;
  readonly request: Request;
  readonly context?: LogicalRequestContext;
};

export function createGuardianRawInvoke(input: {
  pluginOptions: Partial<ChatGPTPluginOptions>;
  original: RawTransport['invoke'];
  evaluate?: GuardianEvaluate;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
  logger?: Pick<Logger, 'info'>;
}): RawTransport['invoke'] {
  return async (request, context, options) => {
    const invocation = (options as InvocationOptions | undefined)?.__aioGuardianInvocation;
    const original = () => {
      request.signal.throwIfAborted();
      if (invocation) invocation.originalTransportStarted = true;
      return input.original(request, context, options);
    };
    const response = await evaluateGuardian({ ...input, request, context });
    if (response === undefined) return original();
    if (invocation) invocation.syntheticGuardianResponse = true;
    return response;
  };
}

export function createGuardianPreRouteInvoke(input: {
  pluginOptions: Partial<ChatGPTPluginOptions>;
  evaluate?: GuardianEvaluate;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
  logger?: Pick<Logger, 'info'>;
}): (request: Request, context: LogicalRequestContext) => Promise<Response | undefined> {
  return (request, context) => evaluateGuardian({ ...input, request, context });
}

async function evaluateGuardian(input: GuardianEvaluationInput): Promise<Response | undefined> {
  const { pluginOptions, evaluate, request, context } = input;
  if (
    (pluginOptions.guardianStrategy !== 'systemOne' && pluginOptions.guardianStrategy !== 'systemOneReviewDenied') ||
    evaluate === undefined ||
    !context?.requestId ||
    pluginOptions.guardianProviderId === undefined ||
    pluginOptions.guardianModelId === undefined
  )
    return;
  const providerId = pluginOptions.guardianProviderId;
  const modelId = pluginOptions.guardianModelId;
  const fallback = (reason: string): undefined => {
    input.logger?.info('Guardian evaluation deferred to the original request path', {
      event: 'guardian.fallback',
      reason,
      requestId: context.requestId,
    });
    return;
  };
  const projected = await projectGuardianRequest(request, fallback);
  request.signal.throwIfAborted();
  if (projected === undefined) return;
  const deadlineAt = performance.now() + 8_000;
  const evaluationSignal = AbortSignal.any([request.signal, (input.timeoutSignal ?? AbortSignal.timeout)(8_000)]);
  const expired = () => {
    request.signal.throwIfAborted();
    return evaluationSignal.aborted || performance.now() >= deadlineAt;
  };
  const body: GuardianSystemOneBody = {
    model: modelId,
    state: projected.state,
    questions: guardianQuestions(),
  };
  if (expired()) return fallback('evaluation_timeout');
  let evaluated: unknown;
  try {
    evaluated = await raceWithAbort(
      () =>
        evaluate({
          providerId,
          modelId,
          body,
          signal: evaluationSignal,
          logicalRequest: context,
        }),
      evaluationSignal,
    );
  } catch {
    request.signal.throwIfAborted();
    return fallback(expired() ? 'evaluation_timeout' : 'evaluation_error');
  }
  if (expired()) return fallback('evaluation_timeout');
  const decision = guardianDecision(evaluated, projected);
  if (expired()) return fallback('evaluation_timeout');
  if (decision === undefined) return fallback('invalid_result');
  if (decision['outcome'] === 'deny' && pluginOptions.guardianStrategy === 'systemOneReviewDenied')
    return fallback('denied_review');
  const response = guardianResponse(decision, projected.stream, projected.model);
  if (expired()) return fallback('evaluation_timeout');
  return response;
}

function raceWithAbort<T>(start: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const reason = () => signal.reason ?? new DOMException('Aborted', 'AbortError');
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(reason());
      return;
    }
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(reason());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      Promise.resolve(start()).then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    }
  });
}
