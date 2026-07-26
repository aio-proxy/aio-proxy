import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import type { ApiProviderTrace } from './api';
import { createApiProvider } from './api';

async function sha256Text(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function waitForTrace(trace: readonly ApiProviderTrace[]): Promise<ApiProviderTrace> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const first = trace[0];
    if (first !== undefined) {
      return first;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error('trace was not recorded');
}

describe('createApiProvider streaming and trace behavior', () => {
  test('surfaces upstream 429 and records rate_limit trace category', async () => {
    const trace: ApiProviderTrace[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response('slow down', { status: 429 });
      },
    });

    try {
      const provider = createApiProvider({
        kind: 'api',
        id: 'openai',
        protocol: ProviderProtocol.OpenAICompatible,
        baseURL: upstream.url.toString(),
        trace,
      });

      const response = await provider.passthrough(new Request('https://proxy.local/v1/chat/completions'));

      expect(response.status).toBe(429);
      expect(await response.text()).toBe('slow down');
      expect(await waitForTrace(trace)).toEqual({
        bodySha256: await sha256Text('slow down'),
        category: 'rate_limit',
        status: 429,
      });
    } finally {
      upstream.stop(true);
    }
  });
});
