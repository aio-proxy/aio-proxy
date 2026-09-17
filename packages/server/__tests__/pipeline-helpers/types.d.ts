import type { TextStreamPart, ToolSet } from '@aio-proxy/core';
import type { StoredSpan } from '@aio-proxy/core/db';
import type { ProviderProtocol, UsageRow } from '@aio-proxy/types';

import type { ModelTransport, RuntimeProviderInstance } from '../../src/runtime';
export declare const REQUESTED_MODEL = 'test-model';
export type ModelPart = TextStreamPart<ToolSet>;
type ModelCall = Parameters<ModelTransport['invoke']>[0];
export type TestProtocolRequest = {
  readonly model: string;
  readonly prompt: string;
  readonly stream: boolean;
  readonly service_tier?: string;
  readonly speed?: string;
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
export type RecordedAttempt = {
  readonly providerId: string;
  readonly modelId: string;
  readonly providerKind: RuntimeProviderInstance['kind'];
  readonly providerWeight?: number;
  readonly routingContractVersion?: number;
  readonly effectivePriority?: number;
  readonly effectiveWeight?: number;
  readonly prioritySource?: 'provider' | 'model';
  readonly weightSource?: 'provider' | 'model';
  readonly selectionSource?:
    | 'provider_qualified'
    | 'response_owner'
    | 'session_affinity'
    | 'deterministic_session'
    | 'weighted_random';
  readonly transport?: 'raw' | 'ai_sdk' | 'image' | 'audio';
  readonly sourceProtocol?: ProviderProtocol;
  readonly targetProtocol?: ProviderProtocol;
  readonly selectionReason?: 'response_owner' | 'affinity' | 'weight';
  readonly attemptIndex?: number;
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
  readonly begins: {
    readonly inboundProtocol: string;
  }[];
  readonly identities: {
    readonly requestedModelId: string;
  }[];
  readonly attempts: RecordedAttempt[];
  readonly finals: RecordedFinal[];
  readonly spans: StoredSpan[];
  readonly settle: () => Promise<void>;
};
export {};
//# sourceMappingURL=types.d.ts.map
