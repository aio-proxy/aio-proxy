import type { ModelInvocation, ProtocolAdapter, RouterCandidate } from '@aio-proxy/core';
import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';
import type { ProviderProtocol } from '@aio-proxy/types';

import type { SessionIdentity } from '../../../logical-session-store';
import type { RequestTraceSession } from '../../../request-tracing';
import type { AttemptResponseObservation } from '../../../response-observation';
import type { ModelTransport, ProviderRouteSource, RuntimeProviderInstance } from '../../../runtime';
import type { AttemptTraceMetadata } from '../attempt-base';
import type { AttemptLog } from '../logging';
import type { ProviderCooldownStore } from '../provider-cooldown';
import type { OpenSpan } from '../tracing';
import type { AttemptEmitter } from './emit';

// A candidate attempt resolves to either a returnable response or a signal to
// fall back to the next candidate. Thrown errors are handled by the loop.
export type AttemptStep =
  | { readonly kind: 'return'; readonly response: Response }
  | { readonly kind: 'fallback'; readonly lastFailure: Response };

// Model invocation is materialized lazily on the first model candidate and
// reused across candidates; both fields are mutated in place by the model path.
export type InvocationHolder = {
  invocation: ModelInvocation | undefined;
  invocationUnsupported: Response | undefined;
};

export type LogAttemptFailure = (
  attemptIndex: number,
  attempt: AttemptLog,
  failureKind: 'response' | 'exception',
  fallback: boolean,
  detail?: { readonly response?: Response; readonly error?: unknown },
) => void;

// Invariants shared by every candidate attempt in one request.
export type AttemptLoopContext<TRequest, TContext> = {
  readonly adapter: ProtocolAdapter<TRequest, TContext>;
  readonly context: TContext;
  readonly rawRequest: Request;
  readonly request: TRequest;
  readonly requestedModelId: string;
  readonly session: RequestTraceSession;
  readonly source: ProviderRouteSource;
  readonly logicalRequest: LogicalRequestContext;
  readonly routingContinuity: Parameters<ModelTransport['invoke']>[0]['routingContinuity'];
  // Real session identity behind logicalRequest, forwarded to commitResponse so
  // the memory fallback resolves the same (source, id) as the persisted path.
  readonly sessionIdentity: SessionIdentity;
  readonly streamRequested: boolean;
  readonly emitter: AttemptEmitter;
  readonly release: () => void;
  readonly deferRelease: () => void;
  readonly logFailure: LogAttemptFailure;
  readonly cooldown: ProviderCooldownStore;
  readonly retryAfterCapMs: number;
};

// Per-candidate facts.
export type CandidateSlot = {
  readonly index: number;
  readonly candidate: RouterCandidate<RuntimeProviderInstance>;
  readonly startedAt: number;
  readonly observation: AttemptResponseObservation;
  readonly hasNext: boolean;
  readonly trace: {
    routingContractVersion: AttemptTraceMetadata['routingContractVersion'];
    providerWeight: AttemptTraceMetadata['providerWeight'];
    effectivePriority: AttemptTraceMetadata['effectivePriority'];
    effectiveWeight: AttemptTraceMetadata['effectiveWeight'];
    prioritySource: AttemptTraceMetadata['prioritySource'];
    weightSource: AttemptTraceMetadata['weightSource'];
    selectionSource: AttemptTraceMetadata['selectionSource'];
    transport?: AttemptTraceMetadata['transport'];
    sourceProtocol: AttemptTraceMetadata['sourceProtocol'];
    targetProtocol?: AttemptTraceMetadata['targetProtocol'];
    selectionReason: AttemptTraceMetadata['selectionReason'];
  };
  readonly inAttempt: <T>(targetProtocol: ProviderProtocol | undefined, operation: () => T) => T;
  // Holds the attempt span once the provider call begins, so a throw during the
  // provider/egress phase reuses it instead of opening a duplicate failure span.
  readonly spanRef: { current: OpenSpan | undefined };
};
