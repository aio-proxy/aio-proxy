import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { createApiProvider } from './api';

describe('createApiProvider', () => {
  test('preserves non-stream request bytes, path, query, and rewrites auth', async () => {
    let seen:
      | {
          readonly authorization: string | null;
          readonly body: string;
          readonly encoding: string | null;
          readonly forwardedBy: string | null;
          readonly host: string | null;
          readonly method: string;
          readonly pathname: string;
          readonly query: string;
          readonly xCustom: string | null;
        }
      | undefined;
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        seen = {
          authorization: req.headers.get('authorization'),
          body: await req.text(),
          encoding: req.headers.get('accept-encoding'),
          forwardedBy: req.headers.get('x-forwarded-by'),
          host: req.headers.get('host'),
          method: req.method,
          pathname: url.pathname,
          query: url.search,
          xCustom: req.headers.get('x-custom'),
        };

        return Response.json({ ok: true });
      },
    });

    process.env.AIO_PROXY_TEST_KEY = 'env-secret';
    try {
      const provider = createApiProvider({
        kind: 'api',
        id: 'openai',
        protocol: ProviderProtocol.OpenAICompatible,
        baseURL: upstream.url.toString(),
        apiKey: '$AIO_PROXY_TEST_KEY',
        models: ['gpt-5-mini'],
      });

      const response = await provider.passthrough(
        new Request('https://proxy.local/v1/chat/completions?a=1&b=two', {
          body: '{"model":"gpt-5-mini"}',
          headers: {
            authorization: 'Bearer old',
            'accept-encoding': 'gzip',
            host: 'proxy.local',
            'content-type': 'application/json',
            'x-custom': 'kept',
          },
          method: 'POST',
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(seen).toEqual({
        authorization: 'Bearer env-secret',
        body: '{"model":"gpt-5-mini"}',
        encoding: 'identity',
        forwardedBy: null,
        host: upstream.url.host,
        method: 'POST',
        pathname: '/v1/chat/completions',
        query: '?a=1&b=two',
        xCustom: 'kept',
      });
    } finally {
      delete process.env.AIO_PROXY_TEST_KEY;
      upstream.stop(true);
    }
  });
});
