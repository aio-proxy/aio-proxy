import { expect, test } from 'bun:test';

import { createApiProvider } from '@aio-proxy/core';
import type { Provider } from '@aio-proxy/types';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { probeApi, providerProbeRequest } from '.';

test.each([
  { expected: 'OK', status: 200 },
  { expected: 'FAIL', status: 502 },
] as const)('uses non-stream transport for a $status probe response', async ({ expected, status }) => {
  let cancelled = false;
  let decompression: boolean | undefined;
  let acceptEncoding: string | null;
  const provider = {
    baseURL: 'https://upstream.test',
    enabled: true,
    id: 'probe',
    kind: ProviderKind.Api,
    models: ['gpt-probe'],
    protocol: ProviderProtocol.OpenAIResponse,
  } as const;
  const instance = createApiProvider(provider, {
    fetch: (async (_input, init) => {
      decompression = (init as { readonly decompress?: boolean } | undefined)?.decompress;
      acceptEncoding = new Headers(init?.headers).get('accept-encoding');
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status },
      );
    }) as typeof globalThis.fetch,
  });

  expect(await probeApi(provider, instance)).toBe(expected);
  expect(cancelled).toBeTrue();
  expect(decompression).toBeUndefined();
  expect(acceptEncoding).toBeNull();
});

test('probe sends the standard inbound path through the primary endpoint transport', async () => {
  let requested: string | undefined;
  const provider = {
    apiKey: 'k',
    baseURL: 'https://api.z.ai/api/paas/v4',
    enabled: true,
    id: 'zai',
    kind: ProviderKind.Api,
    models: ['glm-4.7'],
    protocol: ProviderProtocol.OpenAICompatible,
  } as const;
  const instance = createApiProvider(provider, {
    fetch: (async (input: string | URL | Request) => {
      requested = input instanceof Request ? input.url : String(input);
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch,
  });

  expect(await probeApi(provider, instance)).toBe('OK');
  // origin 模式冻结现状：探测打到 origin + 标准路径，端点 transport 是唯一改写 URL 的地方。
  expect(requested).toBe('https://api.z.ai/v1/chat/completions');
});

test('probe follows sdk base URL semantics for an endpoints-only provider', async () => {
  let requested: string | undefined;
  let apiKeyHeader: string | null = null;
  const provider = {
    apiKey: 'k',
    enabled: true,
    endpoints: [{ protocol: ProviderProtocol.Gemini, baseURL: 'https://g.example.com/v1beta' }],
    id: 'gemini-gateway',
    kind: ProviderKind.Api,
    models: ['gemini-pro'],
  } satisfies Provider;
  const instance = createApiProvider(provider, {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      requested = input instanceof Request ? input.url : String(input);
      apiKeyHeader = new Headers(init?.headers).get('x-goog-api-key');
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch,
  });

  expect(await probeApi(provider, instance)).toBe('OK');
  expect(requested).toBe('https://g.example.com/v1beta/models/gemini-pro:generateContent');
  expect(apiKeyHeader).toBe('k');
});

test('a model test probe waits ten seconds, not one', async () => {
  let timeoutMs: number | undefined;
  const original = AbortSignal.timeout;
  AbortSignal.timeout = ((ms: number) => {
    timeoutMs = ms;
    return original(ms);
  }) as typeof AbortSignal.timeout;
  const provider = {
    apiKey: 'k',
    enabled: true,
    endpoints: { baseURL: 'https://gw.example/v1', protocol: [ProviderProtocol.OpenAICompatible] },
    id: 'slow-gateway',
    kind: ProviderKind.Api,
    models: ['slow-model'],
  } satisfies Provider;
  try {
    const instance = createApiProvider(provider, {
      fetch: (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch,
    });
    expect(await probeApi(provider, instance)).toBe('OK');
    expect(timeoutMs).toBe(10_000);
  } finally {
    AbortSignal.timeout = original;
  }
});

test('image-primary probe posts a generations ping through the primary transport', async () => {
  let requested: string | undefined;
  const provider = {
    apiKey: 'k',
    baseURL: 'https://api.openai.com/v1',
    enabled: true,
    id: 'images',
    kind: ProviderKind.Api,
    models: ['gpt-image-2'],
    protocol: ProviderProtocol.OpenAIImage,
  } as const;
  expect(providerProbeRequest(provider, 'gpt-image-2')).toEqual({
    body: { model: 'gpt-image-2', n: 1, prompt: 'ping' },
    path: '/v1/images/generations',
  });
  const instance = createApiProvider(provider, {
    fetch: (async (input: string | URL | Request) => {
      requested = input instanceof Request ? input.url : String(input);
      return new Response('{}', { status: 200 });
    }) as typeof globalThis.fetch,
  });

  expect(await probeApi(provider, instance)).toBe('OK');
  expect(requested).toBe('https://api.openai.com/v1/images/generations');
});
