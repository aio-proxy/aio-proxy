import type { TextStreamPart, ToolSet } from '@aio-proxy/core';
import type { StoredSpan } from '@aio-proxy/core/db';
import type { ProviderProtocol, UsageRow } from '@aio-proxy/types';

import type { ModelTransport, RuntimeProviderInstance } from '../../src/runtime';

export const REQUESTED_MODEL = 'test-model';
export type ModelPart = TextStreamPart<ToolSet>;
type ModelCall = Parameters<ModelTransport['invoke']>[0];

export type TestProtocolRequest = {
  readonly model: string;
  readonly prompt: string;
  readonly stream: boolean;
};

export type TestProtocolContext = {
  modelInvocationCalls: number;
  parseCalls: number;
  rawRequestCalls: number;
};

export type FakeProvider = {
  readonly calls: {
    ensure: number;
    model: ModelCall[];
    raw: Request[];
  };
  readonly provider: RuntimeProviderInstance;
};

// Projected view of one provider attempt, reconstructed from the
// `aio_proxy.provider.attempt` span attributes captured for a completed trace.
export type RecordedAttempt = {
  readonly providerId: string;
  readonly modelId: string;
  readonly providerKind: RuntimeProviderInstance['kind'];
  readonly providerWeight?: number;
  readonly transport?: 'raw' | 'ai_sdk';
  readonly sourceProtocol?: ProviderProtocol;
  readonly targetProtocol?: ProviderProtocol;
  readonly selectionReason?: 'response_owner' | 'affinity' | 'weight';
  readonly protocol?: ProviderProtocol;
  readonly durationMs: number;
  readonly outcome: 'success' | 'failure' | 'cancelled';
  readonly statusCode?: number;
  readonly errorCode?: string;
  readonly stream?: boolean;
  readonly ttftMs?: number;
  readonly transportObservation?: 'sse' | 'body' | 'unavailable' | 'ambiguous';
  readonly upstreamHeadersMs?: number;
  readonly firstUpstreamByteMs?: number;
  readonly firstSseEventMs?: number;
  readonly contentGapP95Ms?: number;
  readonly maxSseFramesPerRead?: number;
  readonly contentEncoding?: 'identity' | 'gzip' | 'deflate' | 'br' | 'zstd' | 'multiple' | 'other';
};

// Projected terminal summary of one request trace, plus the selected attempt
// when the summary attributes a provider outcome to it.
export type RecordedFinal = {
  readonly outcome: 'success' | 'failure' | 'cancelled';
  readonly finalProviderId?: string;
  readonly finalModelId?: string;
  readonly responseId?: string;
  readonly finalStatusCode?: number;
  readonly errorCode?: string;
  readonly usage?: UsageRow;
  readonly attempt?: RecordedAttempt;
};

export type Recording = {
  readonly begins: { readonly inboundProtocol: string }[];
  readonly identities: { readonly requestedModelId: string }[];
  readonly attempts: RecordedAttempt[];
  readonly finals: RecordedFinal[];
  // Every span from every completed trace, in completion order. Tests that
  // assert non-attempt spans (local-estimate fallback, skipped candidates)
  // filter this by span name.
  readonly spans: StoredSpan[];
  readonly settle: () => Promise<void>;
};
