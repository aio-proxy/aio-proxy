import type { ProviderProtocol } from '@aio-proxy/types';

import type { RuntimeProviderInstance } from '../../runtime';

// Controlled facts about a single provider attempt, shared by the failure
// shaping helpers and the attempt-span emitter. Independent of the recorder.
export type AttemptInfo = {
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
  protocol?: ProviderProtocol,
): AttemptInfo {
  return {
    providerId: provider.id,
    modelId,
    providerKind: provider.kind,
    ...(protocol === undefined ? {} : { protocol }),
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}
