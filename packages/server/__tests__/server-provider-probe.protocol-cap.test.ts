import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer as createBaseServer } from '@aio-proxy/server';
import { ProviderProtocol } from '@aio-proxy/types';

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

  test('Given completion API providers When probed Then generated output is capped per protocol', async () => {
    // Given
    const requests = new Map<string, unknown>();
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(request) {
        requests.set(new URL(request.url).pathname, await request.json());
        return new Response('', { status: 204 });
      },
    });
    const baseURL = `http://127.0.0.1:${upstream.port}`;
    const app = await createServer({
      config: {
        providers: {
          chat: {
            kind: 'api',
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL,
            models: ['chat-model'],
          },
          responses: {
            kind: 'api',
            protocol: ProviderProtocol.OpenAIResponse,
            baseURL,
            models: ['responses-model'],
          },
          gemini: {
            kind: 'api',
            protocol: ProviderProtocol.Gemini,
            baseURL,
            models: ['gemini-model'],
          },
        },
      },
    });

    try {
      // When
      await app.request('/dashboard/api/providers?probe=true&filter=chat', undefined, loopbackServer);
      await app.request('/dashboard/api/providers?probe=true&filter=responses', undefined, loopbackServer);
      await app.request('/dashboard/api/providers?probe=true&filter=gemini', undefined, loopbackServer);

      // Then
      expect(requests.get('/v1/chat/completions')).toMatchObject({ max_tokens: 1 });
      expect(requests.get('/v1/responses')).toMatchObject({ max_output_tokens: 16 });
      expect(requests.get('/v1beta/models/gemini-model:generateContent')).toMatchObject({
        generationConfig: { maxOutputTokens: 1 },
      });
    } finally {
      await upstream.stop(true);
    }
  });
});
