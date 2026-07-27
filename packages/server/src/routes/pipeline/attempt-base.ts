import type { ProviderProtocol } from '@aio-proxy/types';

import type { RuntimeProviderInstance } from '../../runtime';

export type AttemptTraceMetadata = {
  readonly providerWeight?: number;
  readonly transport?: 'raw' | 'ai_sdk';
  readonly sourceProtocol: ProviderProtocol;
  readonly targetProtocol?: ProviderProtocol;
  readonly selectionReason: 'response_owner' | 'affinity' | 'weight';
};

// Controlled facts about a single provider attempt, shared by the failure
// shaping helpers and the attempt-span emitter. Independent of the recorder.
export type AttemptInfo = AttemptTraceMetadata & {
  readonly providerId: string;
  readonly modelId: string;
  readonly providerKind: RuntimeProviderInstance['kind'];
  readonly protocol?: ProviderProtocol;
  readonly durationMs: number;
};

export function attemptBase(
  provider: RuntimeProviderInstance,
  modelId: string,
  startedAt: number,
  metadata: AttemptTraceMetadata,
): AttemptInfo {
  return {
    ...metadata,
    providerId: provider.id,
    modelId,
    providerKind: provider.kind,
    ...(metadata.targetProtocol === undefined ? {} : { protocol: metadata.targetProtocol }),
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}
