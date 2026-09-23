import { expect, test } from 'bun:test';

import type { CredentialPort, RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { resetLatestCodexRsVersionCache } from '../plugin-options/codex-version';
import type { ChatGPTCredential } from '../schema';

test('routes the final ChatGPT request through the host fetch', async () => {
  resetLatestCodexRsVersionCache();
  const originalFetch = globalThis.fetch;
  const clientId = Reflect.get(globalThis, '__AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__');
  const controlRequests: Request[] = [];
  const modelRequests: Request[] = [];
  Reflect.set(globalThis, '__AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__', clientId ?? 'test-client-id');
  globalThis.fetch = async () => {
    throw new Error('unexpected global fetch');
  };

  try {
    const { createOpenAIChatGPTRuntime } = await import('.');
    const runtime = await createOpenAIChatGPTRuntime({
      credentials: credentialPort(),
      options: {},
      catalog: emptyCatalog(),
      fetch: (async (input: RequestInfo | URL, init?: RuntimeRequestInit) => {
        const traffic = init?.aioProxy?.traffic ?? 'model';
        const request = new Request(input, init);
        if (traffic === 'control') {
          controlRequests.push(request);
          return Response.json({ tag_name: 'rust-v9.9.9', name: '@openai/codex', version: '9.9.9' });
        }
        modelRequests.push(request);
        return Response.json({ ok: true });
      }) as RuntimeFetch,
    });
    const transport = runtime.raw?.({ protocol: 'openai-response', modelId: 'gpt-5.5' });
    if (transport === undefined) throw new Error('missing ChatGPT raw transport');

    await transport.invoke(
      new Request('http://127.0.0.1:22078/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: '127.0.0.1:22078' },
        body: JSON.stringify({ model: 'gpt-5.5', input: 'hello' }),
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreGlobal('__AIO_PROXY_OPENAI_CHATGPT_CLIENT_ID__', clientId);
  }

  expect(controlRequests.map((request) => new URL(request.url).hostname).sort()).toEqual([
    'api.github.com',
    'registry.npmjs.org',
  ]);
  expect(controlRequests.every((request) => !request.headers.has('authorization'))).toBe(true);
  expect(modelRequests).toHaveLength(1);
  const request = modelRequests[0];
  expect(request?.url).toBe('https://chatgpt.com/backend-api/codex/responses');
  expect(request?.headers.get('authorization')).toBe('Bearer access-token');
  expect(request?.headers.get('chatgpt-account-id')).toBe('acct-123');
  expect(request?.headers.get('originator')).toBe('codex-tui');
  expect(request?.headers.get('user-agent')).toContain('codex-tui/9.9.9');
  expect(request?.headers.get('host')).toBeNull();
});

function credentialPort(): CredentialPort<ChatGPTCredential> {
  const value = {
    accessToken: 'access-token',
    accountId: 'acct-123',
    expiresAt: Date.now() + 60_000,
    refreshToken: 'refresh-token',
  };
  return {
    read: async () => ({ revision: 1, value }),
    refresh: async () => {
      throw new Error('valid credentials must not refresh');
    },
  };
}

function emptyCatalog() {
  return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
}

function restoreGlobal(key: string, value: unknown): void {
  if (value === undefined) Reflect.deleteProperty(globalThis, key);
  else Reflect.set(globalThis, key, value);
}
