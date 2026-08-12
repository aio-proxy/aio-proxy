import { expect, test } from 'bun:test';

import type { AiSdkProviderInstance, ApiProviderInstance } from '@aio-proxy/core';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { materializeRuntimeProvider } from './materialize';

test('materializes configured target protocol resolvers', () => {
  const invoke = () => new ReadableStream();
  const aiSdk = {
    enabled: true,
    id: 'ai-sdk',
    invoke,
    kind: ProviderKind.AiSdk,
    targetProtocol: ProviderProtocol.Anthropic,
  } satisfies AiSdkProviderInstance;
  const aiSdkRuntime = materializeRuntimeProvider(aiSdk);

  expect(aiSdkRuntime.model?.targetProtocol?.('any-model')).toBe(ProviderProtocol.Anthropic);

  const passthrough = async () => new Response();
  const api = {
    baseURL: 'https://api.example.test',
    enabled: true,
    endpointTransports: [{ protocol: ProviderProtocol.Gemini, passthrough }],
    id: 'api',
    kind: ProviderKind.Api,
    passthrough,
    protocol: ProviderProtocol.Gemini,
  } satisfies ApiProviderInstance;
  const bridge = {
    enabled: true,
    id: 'api:bridge',
    invoke,
    kind: ProviderKind.AiSdk,
    targetProtocol: ProviderProtocol.Gemini,
  } satisfies AiSdkProviderInstance;
  const apiRuntime = materializeRuntimeProvider(api, { apiBridge: bridge });

  expect(apiRuntime.model?.targetProtocol?.('any-model')).toBe(ProviderProtocol.Gemini);
});
