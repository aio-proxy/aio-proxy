import type { AiSdkProviderInstance, ApiProviderInstance } from '@aio-proxy/core';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

export function stubApiInstance(id: string): ApiProviderInstance {
  return {
    baseURL: 'https://api.example.com',
    enabled: true,
    id,
    kind: ProviderKind.Api,
    passthrough: async () => new Response(),
    protocol: ProviderProtocol.OpenAICompatible,
  };
}

export function stubAiSdkInstance(id: string): AiSdkProviderInstance {
  return { enabled: true, id, invoke: () => new ReadableStream(), kind: ProviderKind.AiSdk };
}
