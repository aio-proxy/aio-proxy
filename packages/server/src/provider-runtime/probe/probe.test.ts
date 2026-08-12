import { expect, test } from 'bun:test';

import { createApiProvider } from '@aio-proxy/core';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { probeApi } from '.';

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
