import { expect, test } from 'bun:test';

import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { createApiProvider } from './api';

type Captured = { readonly url: string; readonly headers: Headers };

function capturingFetch(captured: Captured[]): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    captured.push({ url, headers: new Headers(init?.headers) });
    return new Response('{}', { status: 200 });
  }) as typeof globalThis.fetch;
}

const provider = {
  apiKey: 'k',
  baseURL: 'https://api.z.ai/api/paas/v4',
  enabled: true,
  id: 'zai',
  kind: ProviderKind.Api,
  models: ['glm-4.7'],
  protocol: ProviderProtocol.OpenAICompatible,
  endpoints: [
    { protocol: ProviderProtocol.Anthropic, baseURL: 'https://api.z.ai/api/anthropic/v1', auth: 'bearer' },
    { protocol: ProviderProtocol.Gemini, baseURL: 'https://g.example.com/v1beta' },
  ],
} as const;

test('primary transport keeps frozen origin semantics and passthrough alias', async () => {
  const captured: Captured[] = [];
  const instance = createApiProvider(provider, { fetch: capturingFetch(captured) });

  expect(instance.endpointTransports.map((endpoint) => endpoint.protocol)).toEqual([
    ProviderProtocol.OpenAICompatible,
    ProviderProtocol.Anthropic,
    ProviderProtocol.Gemini,
  ]);
  await instance.passthrough(
    new Request('http://proxy.local/v1/chat/completions?a=1', { method: 'POST', body: '{}' }),
    { upstreamStream: false },
  );
  // origin 模式冻结现状：丢弃 baseURL 的 /api/paas/v4 前缀。
  expect(captured[0]?.url).toBe('https://api.z.ai/v1/chat/completions?a=1');
  expect(captured[0]?.headers.get('authorization')).toBe('Bearer k');
});

test('sdk anthropic endpoint joins operation path and honors bearer auth', async () => {
  const captured: Captured[] = [];
  const instance = createApiProvider(provider, { fetch: capturingFetch(captured) });
  const anthropic = instance.endpointTransports.find((e) => e.protocol === ProviderProtocol.Anthropic);

  await anthropic?.passthrough(new Request('http://proxy.local/v1/messages', { method: 'POST', body: '{}' }), {
    upstreamStream: false,
  });
  await anthropic?.passthrough(
    new Request('http://proxy.local/v1/messages/count_tokens', { method: 'POST', body: '{}' }),
    { upstreamStream: false },
  );

  expect(captured[0]?.url).toBe('https://api.z.ai/api/anthropic/v1/messages');
  expect(captured[0]?.headers.get('authorization')).toBe('Bearer k');
  expect(captured[0]?.headers.get('x-api-key')).toBeNull();
  expect(captured[1]?.url).toBe('https://api.z.ai/api/anthropic/v1/messages/count_tokens');
});

test('sdk anthropic endpoint defaults to x-api-key without auth override', async () => {
  const captured: Captured[] = [];
  const instance = createApiProvider(
    {
      ...provider,
      endpoints: [{ protocol: ProviderProtocol.Anthropic, baseURL: 'https://api.z.ai/api/anthropic/v1' }],
    },
    { fetch: capturingFetch(captured) },
  );
  const anthropic = instance.endpointTransports.find((e) => e.protocol === ProviderProtocol.Anthropic);
  await anthropic?.passthrough(new Request('http://proxy.local/v1/messages', { method: 'POST', body: '{}' }), {
    upstreamStream: false,
  });

  expect(captured[0]?.headers.get('x-api-key')).toBe('k');
  expect(captured[0]?.headers.get('authorization')).toBeNull();
});

test('sdk gemini endpoint strips /v1beta prefix and keeps query', async () => {
  const captured: Captured[] = [];
  const instance = createApiProvider(provider, { fetch: capturingFetch(captured) });
  const gemini = instance.endpointTransports.find((e) => e.protocol === ProviderProtocol.Gemini);
  await gemini?.passthrough(
    new Request('http://proxy.local/v1beta/models/gemini-pro:streamGenerateContent?alt=sse', {
      method: 'POST',
      body: '{}',
    }),
    { upstreamStream: false },
  );

  expect(captured[0]?.url).toBe('https://g.example.com/v1beta/models/gemini-pro:streamGenerateContent?alt=sse');
  expect(captured[0]?.headers.get('x-goog-api-key')).toBe('k');
});
