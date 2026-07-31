import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { createApiProvider } from './api';

describe('createApiProvider', () => {
  test.each([
    ProviderProtocol.OpenAIResponse,
    ProviderProtocol.OpenAICompatible,
    ProviderProtocol.Anthropic,
    ProviderProtocol.Gemini,
  ] as const)(
    'routes upstream calls through an injected fetch and applies configured headers last for %s',
    async (protocol) => {
      let seenHeaders: Headers | undefined;
      const injectedFetch = (async (_input: unknown, init?: RequestInit) => {
        seenHeaders = new Headers(init?.headers);
        return Response.json({ ok: true });
      }) as typeof globalThis.fetch;

      const provider = createApiProvider(
        {
          kind: 'api',
          id: 'provider',
          protocol,
          baseURL: 'https://upstream.example',
          apiKey: 'provider-key',
          headers: {
            Authorization: 'Configured authorization',
            Host: 'configured-host.example',
            'X-Api-Key': 'configured-api-key',
            'X-Goog-Api-Key': 'configured-google-key',
            'Accept-Encoding': 'configured-encoding',
            'X-Tenant': 'team-a',
          },
        },
        { fetch: injectedFetch },
      );

      await provider.passthrough(
        new Request('https://proxy.local/v1/test', {
          headers: {
            authorization: 'Bearer client-token',
            'x-api-key': 'client-anthropic-key',
            'x-goog-api-key': 'client-gemini-key',
            'accept-encoding': 'gzip',
            host: 'proxy.local',
          },
        }),
      );

      expect(seenHeaders?.get('authorization')).toBe('Configured authorization');
      expect(seenHeaders?.get('host')).toBe('configured-host.example');
      expect(seenHeaders?.get('x-api-key')).toBe('configured-api-key');
      expect(seenHeaders?.get('x-goog-api-key')).toBe('configured-google-key');
      expect(seenHeaders?.get('accept-encoding')).toBe('configured-encoding');
      expect(seenHeaders?.get('x-tenant')).toBe('team-a');
    },
  );

  test('strips client encoding before applying managed stream policy and configured headers', async () => {
    const calls: { readonly decompress: boolean | undefined; readonly headers: Headers }[] = [];
    const injectedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        decompress: (init as { readonly decompress?: boolean } | undefined)?.decompress,
        headers: new Request(input, init).headers,
      });
      return Response.json({ ok: true });
    }) as typeof globalThis.fetch;
    const request = () => new Request('https://proxy.local/v1/responses', { headers: { 'accept-encoding': 'gzip' } });
    const provider = createApiProvider(
      {
        kind: 'api',
        id: 'managed',
        protocol: ProviderProtocol.OpenAIResponse,
        baseURL: 'https://upstream.example',
      },
      { fetch: injectedFetch },
    );
    const configured = createApiProvider(
      {
        kind: 'api',
        id: 'configured',
        protocol: ProviderProtocol.OpenAIResponse,
        baseURL: 'https://upstream.example',
        headers: { 'Accept-Encoding': 'zstd' },
      },
      { fetch: injectedFetch },
    );

    await provider.passthrough(request(), { upstreamStream: true });
    await provider.passthrough(request(), { upstreamStream: false });
    await configured.passthrough(request(), { upstreamStream: true });
    await configured.passthrough(request(), { upstreamStream: false });

    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({ decompress: false });
    expect(calls[0]?.headers.get('accept-encoding')).toBe('identity');
    expect(calls[1]).toMatchObject({ decompress: undefined });
    expect(calls[1]?.headers.has('accept-encoding')).toBe(false);
    expect(calls[2]).toMatchObject({ decompress: false });
    expect(calls[2]?.headers.get('accept-encoding')).toBe('zstd');
    expect(calls[3]).toMatchObject({ decompress: undefined });
    expect(calls[3]?.headers.get('accept-encoding')).toBe('zstd');
  });
});
