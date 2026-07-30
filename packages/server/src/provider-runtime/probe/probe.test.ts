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
