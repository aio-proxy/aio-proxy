import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { createApiProvider } from './api';

const protocols = [
  ProviderProtocol.OpenAICompatible,
  ProviderProtocol.OpenAIResponse,
  ProviderProtocol.Anthropic,
  ProviderProtocol.Gemini,
  ProviderProtocol.GeminiInteractions,
] as const;
const credentialHeaders = ['authorization', 'proxy-authorization', 'cookie', 'x-api-key', 'x-goog-api-key'];

describe('createApiProvider', () => {
  test.each(protocols)(
    'removes inbound client credentials for %s when no provider key is configured',
    async (protocol) => {
      let seen: Headers | undefined;
      const upstream = Bun.serve({
        port: 0,
        fetch(request) {
          seen = new Headers(request.headers);
          return Response.json({ ok: true });
        },
      });

      try {
        const provider = createApiProvider({
          kind: 'api',
          id: 'provider',
          protocol,
          baseURL: upstream.url.toString(),
        });
        await provider.passthrough(
          new Request('https://proxy.local/v1/test', {
            headers: {
              authorization: 'Bearer client-token',
              'proxy-authorization': 'Basic client-proxy-token',
              cookie: 'session=client-cookie',
              'x-api-key': 'client-anthropic-key',
              'x-goog-api-key': 'client-gemini-key',
              'x-custom': 'kept',
            },
          }),
        );

        for (const name of credentialHeaders) expect(seen?.get(name)).toBeNull();
        expect(seen?.get('x-custom')).toBe('kept');
      } finally {
        upstream.stop(true);
      }
    },
  );

  test.each([
    [ProviderProtocol.OpenAICompatible, 'authorization', 'Bearer provider-key'],
    [ProviderProtocol.OpenAIResponse, 'authorization', 'Bearer provider-key'],
    [ProviderProtocol.Anthropic, 'x-api-key', 'provider-key'],
    [ProviderProtocol.Gemini, 'x-goog-api-key', 'provider-key'],
    [ProviderProtocol.GeminiInteractions, 'x-goog-api-key', 'provider-key'],
  ] as const)('owns the configured upstream credential for %s', async (protocol, headerName, headerValue) => {
    let seen: Headers | undefined;
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        seen = new Headers(request.headers);
        return Response.json({ ok: true });
      },
    });

    try {
      const provider = createApiProvider({
        kind: 'api',
        id: 'provider',
        protocol,
        baseURL: upstream.url.toString(),
        apiKey: 'provider-key',
      });
      await provider.passthrough(
        new Request('https://proxy.local/v1/test', {
          headers: Object.fromEntries(credentialHeaders.map((name) => [name, `client-${name}`])),
        }),
      );

      for (const name of credentialHeaders) {
        expect(seen?.get(name)).toBe(name === headerName ? headerValue : null);
      }
    } finally {
      upstream.stop(true);
    }
  });
});
