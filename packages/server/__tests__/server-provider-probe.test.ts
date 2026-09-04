import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderProtocol } from '@aio-proxy/types';

import { createServer as createBaseServer } from '#server-test-lifecycle';

import { loopbackServer } from '../src/dashboard-auth/test-support';

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

  test('Given configured provider When dashboard providers are requested Then summary and probe status are returned', async () => {
    // Given
    let pathSeen = '';
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        pathSeen = new URL(request.url).pathname;
        return new Response('', { status: 204 });
      },
    });
    const app = await createServer({
      config: {
        providers: {
          openai: {
            kind: 'api',
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: `http://127.0.0.1:${upstream.port}`,
            models: ['gpt-test'],
            weight: 7,
          },
        },
      },
    });

    try {
      // When
      const list = await app.request('/dashboard/api/providers', undefined, loopbackServer);
      const probe = await app.request('/dashboard/api/providers?probe=true&filter=openai', undefined, loopbackServer);

      // Then
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({
        routingRevision: expect.stringMatching(/^[a-f0-9]{64}$/u),
        providers: [
          {
            id: 'openai',
            kind: 'api',
            enabled: true,
            passthrough: true,
            last_status: 'unknown',
            last_latency: null,
            priority: 0,
            weight: 7,
            protocols: [ProviderProtocol.OpenAICompatible],
            hasQuota: false,
            clientModels: ['gpt-test'],
            hasApiKey: false,
            state: { status: 'ready' },
          },
        ],
      });
      const probeBody = await probe.json();
      expect(probe.status).toBe(200);
      expect(probeBody.providers[0].probe).toBe('OK');
      expect(probeBody.providers[0].last_status).toBe('OK');
      expect(typeof probeBody.providers[0].last_latency).toBe('number');
      expect(pathSeen).toBe('/v1/chat/completions');
    } finally {
      await upstream.stop(true);
    }
  });

  test('Given an API key When a provider is probed Then the upstream request is authenticated', async () => {
    let authorization: string | null = null;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        authorization = request.headers.get('authorization');
        return new Response('', { status: 204 });
      },
    });
    const app = await createServer({
      config: {
        providers: {
          authenticated: {
            kind: 'api',
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: `http://127.0.0.1:${upstream.port}`,
            apiKey: 'probe-secret',
            models: ['gpt-test'],
          },
        },
      },
    });

    try {
      await app.request('/dashboard/api/providers?probe=true&filter=authenticated', undefined, loopbackServer);
      expect(authorization).toBe('Bearer probe-secret');
    } finally {
      await upstream.stop(true);
    }
  });
});
