import { AsyncLocalStorage } from 'node:async_hooks';

import type { ProviderProtocol } from '@aio-proxy/types';

import type { ServerLogSink } from '../server-log';

export type RequestLogContext = {
  readonly requestId: string;
  readonly attemptIndex?: number;
  readonly providerId?: string;
  readonly modelId?: string;
};

export type ProviderAttemptContext = {
  readonly providerId: string;
  readonly modelId: string;
  readonly requestedModelId: string;
  readonly sourceProtocol: ProviderProtocol;
  readonly targetProtocol?: ProviderProtocol;
};

export type AttemptLogContext = Required<Omit<RequestLogContext, 'requestId'>> &
  Partial<Omit<ProviderAttemptContext, 'providerId' | 'modelId'>>;

export type RequestLogScope = RequestLogContext &
  Partial<Omit<ProviderAttemptContext, 'providerId' | 'modelId'>> & {
    readonly debug: boolean;
    readonly logger: ServerLogSink;
  };

const storage = new AsyncLocalStorage<RequestLogScope>();

export function withRequestLogContext<T>(input: RequestLogScope, operation: () => T): T {
  return storage.run(input, operation);
}

export function withAttemptLogContext<T>(input: AttemptLogContext, operation: () => T): T {
  const parent = storage.getStore();
  return parent === undefined ? operation() : storage.run({ ...parent, ...input }, operation);
}

export function currentRequestLogContext(): RequestLogContext | undefined {
  const scope = storage.getStore();
  if (scope === undefined) return undefined;
  return {
    requestId: scope.requestId,
    ...(scope.attemptIndex === undefined ? {} : { attemptIndex: scope.attemptIndex }),
    ...(scope.providerId === undefined ? {} : { providerId: scope.providerId }),
    ...(scope.modelId === undefined ? {} : { modelId: scope.modelId }),
  };
}

export function currentProviderAttemptContext(): ProviderAttemptContext | undefined {
  const scope = storage.getStore();
  if (
    scope?.providerId === undefined ||
    scope.modelId === undefined ||
    scope.requestedModelId === undefined ||
    scope.sourceProtocol === undefined
  )
    return undefined;
  return {
    providerId: scope.providerId,
    modelId: scope.modelId,
    requestedModelId: scope.requestedModelId,
    sourceProtocol: scope.sourceProtocol,
    ...(scope.targetProtocol === undefined ? {} : { targetProtocol: scope.targetProtocol }),
  };
}

export function currentDebugRequestLogScope(): RequestLogScope | undefined {
  const scope = storage.getStore();
  return scope?.debug === true ? scope : undefined;
}
