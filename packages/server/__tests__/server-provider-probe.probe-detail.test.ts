import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderProtocol } from '@aio-proxy/types';

import { createServer as createBaseServer } from '#server-test-lifecycle';

import { loopbackServer } from '../src/dashboard-auth/test-support';
import { config } from './server.test-support';

describe('server routes', () => {
  let dir: string;
  const createServer = (options: Parameters<typeof createBaseServer>[0]) =>
    createBaseServer({ ...options, dbHome: dir });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aio-proxy-server-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('Given configured models When a provider is probed Then the first real model is used', async () => {
    let model: unknown;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        const body = await request.json();
        model = typeof body === 'object' && body !== null && 'model' in body ? body.model : undefined;
        return new Response('', { status: 204 });
      },
    });
    const app = await createServer({
      config: {
        providers: {
          configured: {
            kind: 'api',
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: `http://127.0.0.1:${upstream.port}`,
            models: ['gpt-real', 'gpt-fallback'],
          },
        },
      },
    });

    try {
      await app.request('/dashboard/api/providers?probe=true&filter=configured', undefined, loopbackServer);
      expect(model).toBe('gpt-real');
    } finally {
      await upstream.stop(true);
    }
  });

  test('Given configured provider When dashboard provider detail is requested Then one provider is returned', async () => {
    // Given
    const app = await createServer({ config });

    // When
    const found = await app.request('/dashboard/api/providers/openai-compatible', undefined, loopbackServer);
    const missing = await app.request('/dashboard/api/providers/missing', undefined, loopbackServer);

    // Then
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({
      provider: {
        id: 'openai-compatible',
        kind: 'api',
        enabled: true,
        passthrough: true,
        last_status: 'unknown',
        last_latency: null,
        protocol: ProviderProtocol.OpenAICompatible,
        clientModels: ['gpt-alias', 'gpt-test'],
        hasApiKey: true,
        state: { status: 'ready' },
      },
    });
    expect(missing.status).toBe(404);
  });
});
