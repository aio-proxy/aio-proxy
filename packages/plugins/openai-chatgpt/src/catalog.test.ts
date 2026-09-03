import { afterEach, expect, test } from 'bun:test';

import type { CredentialPort, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { CODEX_MODELS_ENDPOINT, discoverOpenAIChatGPTModels } from './catalog';
import type { ChatGPTCredential } from './schema';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function credential(overrides: Partial<ChatGPTCredential> = {}): ChatGPTCredential {
  return {
    accessToken: 'access-token',
    accountId: 'acct-123',
    expiresAt: Date.now() + 60_000,
    refreshToken: 'refresh-token',
    ...overrides,
  };
}

function staticCredentialPort(value: ChatGPTCredential): CredentialPort<ChatGPTCredential> {
  return {
    read: async () => ({ revision: 1, value }),
    refresh: async () => {
      throw new Error('valid credentials must not refresh');
    },
  };
}

test('queries the account Codex models endpoint with pinned client version and ChatGPT auth', async () => {
  const calls: { readonly url: string; readonly headers: Headers; readonly traffic: string | undefined }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RuntimeRequestInit) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      headers: new Headers(request.headers),
      traffic: init?.aioProxy?.traffic,
    });
    return Response.json({ models: [] });
  }) as typeof globalThis.fetch;

  await discoverOpenAIChatGPTModels(staticCredentialPort(credential()), new AbortController().signal);

  const call = calls[0];
  if (call === undefined) throw new Error('missing catalog fetch');
  const url = new URL(call.url);
  expect(`${url.origin}${url.pathname}`).toBe(CODEX_MODELS_ENDPOINT);
  expect(url.searchParams.get('client_version')).toBe('0.135.0');
  expect(call.headers.get('authorization')).toBe('Bearer access-token');
  expect(call.headers.get('ChatGPT-Account-Id')).toBe('acct-123');
  expect(call.headers.get('Originator')).toBe('codex-tui');
  expect(call.headers.get('User-Agent')).toBe(
    'codex-tui/0.135.0 (Mac OS 26.5.0; arm64) iTerm.app/3.6.10 (codex-tui; 0.135.0)',
  );
  expect(call.traffic).toBe('control');
});

test('exposes api-unsupported and hidden ChatGPT models in priority order', async () => {
  globalThis.fetch = async () =>
    Response.json({
      models: [
        {
          slug: 'codex-auto-review',
          display_name: 'Codex Auto Review',
          priority: 43,
          supported_in_api: true,
          visibility: 'hide',
        },
        {
          slug: 'gpt-5.3-codex-spark',
          display_name: 'GPT-5.3-Codex-Spark',
          priority: 26,
          supported_in_api: false,
          visibility: 'list',
        },
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', priority: 12, supported_in_api: true, visibility: 'list' },
      ],
    });

  await expect(
    discoverOpenAIChatGPTModels(staticCredentialPort(credential()), new AbortController().signal),
  ).resolves.toEqual([
    { id: 'gpt-5.5', displayName: 'GPT-5.5', extra: { protocol: 'openai-response' } },
    { id: 'gpt-5.3-codex-spark', displayName: 'GPT-5.3-Codex-Spark', extra: { protocol: 'openai-response' } },
    { id: 'codex-auto-review', displayName: 'Codex Auto Review', extra: { protocol: 'openai-response' } },
  ]);
});

test('refreshes an expired credential before querying the catalog', async () => {
  const headers: Headers[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    headers.push(new Headers(new Request(input, init).headers));
    return Response.json({ models: [] });
  }) as typeof globalThis.fetch;
  const port: CredentialPort<ChatGPTCredential> = {
    read: async () => ({ revision: 7, value: credential({ accessToken: 'stale', expiresAt: Date.now() - 1 }) }),
    refresh: async (revision) => {
      expect(revision).toBe(7);
      return { status: 'updated', snapshot: { revision: 8, value: credential({ accessToken: 'fresh' }) } };
    },
  };

  await discoverOpenAIChatGPTModels(port, new AbortController().signal);

  expect(headers[0]?.get('authorization')).toBe('Bearer fresh');
});

test('ignores unknown upstream fields while keeping the lean projection', async () => {
  globalThis.fetch = async () =>
    Response.json({
      models: [
        {
          slug: 'gpt-5.5',
          display_name: 'GPT-5.5',
          priority: 12,
          supported_in_api: true,
          visibility: 'list',
          model_messages: { instructions_template: 'x'.repeat(20000) },
          brand_new_field: true,
        },
      ],
    });

  await expect(
    discoverOpenAIChatGPTModels(staticCredentialPort(credential()), new AbortController().signal),
  ).resolves.toEqual([{ id: 'gpt-5.5', displayName: 'GPT-5.5', extra: { protocol: 'openai-response' } }]);
});

test('fails loudly when the models endpoint rejects the account', async () => {
  globalThis.fetch = async () => new Response('nope', { status: 401 });

  await expect(
    discoverOpenAIChatGPTModels(staticCredentialPort(credential()), new AbortController().signal),
  ).rejects.toThrow('Codex model catalog request failed with 401');
});
