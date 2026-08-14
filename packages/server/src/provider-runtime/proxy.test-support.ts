import type { AiSdkProviderInstance, ApiProviderInstance } from '@aio-proxy/core';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

export function stubApiInstance(id: string): ApiProviderInstance {
  const passthrough = async () => new Response();
  return {
    baseURL: 'https://api.example.com',
    enabled: true,
    endpointTransports: [{ protocol: ProviderProtocol.OpenAICompatible, passthrough }],
    id,
    kind: ProviderKind.Api,
    passthrough,
    protocol: ProviderProtocol.OpenAICompatible,
  };
}

export function stubAiSdkInstance(id: string): AiSdkProviderInstance {
  return { enabled: true, id, invoke: () => new ReadableStream(), kind: ProviderKind.AiSdk };
}
