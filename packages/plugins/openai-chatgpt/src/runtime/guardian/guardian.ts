import type { LogicalRequestContext, RawTransport, RawTransportOptions } from '@aio-proxy/plugin-sdk';

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
  readonly body: GuardianSystemOneBody;
  readonly signal: AbortSignal;
  readonly logicalRequest: LogicalRequestContext;
}) => Promise<unknown>;

type InvocationOptions = RawTransportOptions & {
  readonly __aioGuardianInvocation?: { originalTransportStarted: boolean; syntheticGuardianResponse: boolean };
};

export function createGuardianRawInvoke(input: {
  pluginOptions: Partial<ChatGPTPluginOptions>;
  original: RawTransport['invoke'];
  evaluate?: GuardianEvaluate;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
}): RawTransport['invoke'] {
  const { pluginOptions, evaluate } = input;
  return async (request, context, options) => {
    const invocation = (options as InvocationOptions | undefined)?.__aioGuardianInvocation;
    const original = () => {
      request.signal.throwIfAborted();
      if (invocation) invocation.originalTransportStarted = true;
      return input.original(request, context, options);
    };
    if (
      pluginOptions.guardianStrategy === 'default' ||
      pluginOptions.guardianStrategy === undefined ||
      evaluate === undefined ||
      !context?.requestId ||
      pluginOptions.guardianProviderId === undefined ||
      pluginOptions.guardianModelId === undefined
    )
      return original();
    const projected = await projectGuardianRequest(request);
    request.signal.throwIfAborted();
    if (projected === undefined) return original();
    const deadlineAt = performance.now() + 8_000;
    const evaluationSignal = AbortSignal.any([request.signal, (input.timeoutSignal ?? AbortSignal.timeout)(8_000)]);
    const expired = () => {
      request.signal.throwIfAborted();
      return evaluationSignal.aborted || performance.now() >= deadlineAt;
    };
    const body: GuardianSystemOneBody = {
      model: pluginOptions.guardianModelId,
      state: projected.state,
      questions: guardianQuestions(),
    };
    if (expired()) return original();
    let evaluated: unknown;
    try {
      evaluated = await raceWithAbort(
        () =>
          evaluate({
            providerId: pluginOptions.guardianProviderId!,
            modelId: pluginOptions.guardianModelId!,
            body,
            signal: evaluationSignal,
            logicalRequest: context,
          }),
        evaluationSignal,
      );
    } catch {
      return original();
    }
    if (expired()) return original();
    const decision = guardianDecision(evaluated, projected);
    if (expired()) return original();
    if (
      decision === undefined ||
      (decision['outcome'] === 'deny' && pluginOptions.guardianStrategy === 'systemOneReviewDenied')
    )
      return original();
    const response = guardianResponse(decision, projected.stream, projected.model);
    if (expired()) return original();
    if (invocation) invocation.syntheticGuardianResponse = true;
    return response;
  };
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
