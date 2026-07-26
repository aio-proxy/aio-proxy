import { type ModelInvocation, type ProtocolAdapter, type RouterResolution } from '@aio-proxy/core';
import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';

import type { RequestAttemptInput, RequestSession } from '../../request-recorder';
import type { ProviderRouteSource, RuntimeProviderInstance } from '../../runtime';

export type AttemptOutcome =
  | { readonly kind: 'return'; readonly response: Response }
  | { readonly kind: 'fallback'; readonly lastFailure: Response };

export type InvocationState = {
  invocation: ModelInvocation | undefined;
  invocationUnsupported: Response | undefined;
};

export type LogAttemptFailure = (
  attemptIndex: number,
  attempt: RequestAttemptInput,
  failureKind: 'response' | 'exception',
  fallback: boolean,
  detail?: { readonly response?: Response; readonly error?: unknown },
) => void;

export type AttemptContext<TRequest, TContext> = {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly context: TContext;
  readonly rawRequest: Request;
  readonly request: TRequest;
  readonly requestedModelId: string;
  readonly session: RequestSession;
  readonly source: ProviderRouteSource;
  readonly logicalRequest: LogicalRequestContext;
  readonly release: () => void;
  readonly deferRelease: () => void;
  readonly logFailure: LogAttemptFailure;
};

export type CandidateAttempt = {
  readonly index: number;
  readonly candidate: RouterResolution<RuntimeProviderInstance>;
  readonly startedAt: number;
  readonly hasNext: boolean;
  readonly inAttempt: <T>(operation: () => T) => T;
};
