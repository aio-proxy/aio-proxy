import { expect, test } from 'bun:test';

import type { CredentialPort, ModelCatalog, RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import { credentialPort as createCredentialPort } from '../../__tests__/test-support';
import type { GitHubCopilotCredential } from '../github-api';

test('routes the final GitHub Copilot request through the host fetch', async () => {
  const originalFetch = globalThis.fetch;
  const clientId = Reflect.get(globalThis, '__AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__');
  const calls = fetchCalls();
  Reflect.set(globalThis, '__AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__', clientId ?? 'test-client-id');
  globalThis.fetch = async () => {
    throw new Error('unexpected global fetch');
  };

  try {
    const { createGitHubCopilotRuntime } = await import('./runtime');
    const runtime = await createGitHubCopilotRuntime({
      credentials: credentialPort(),
      options: { deploymentType: 'github.com' },
      catalog: catalog(),
      fetch: hostFetch(calls, async (traffic) => {
        if (traffic === 'control') throw new Error('unexpected control fetch');
        return Response.json({ ok: true });
      }),
    });
    const transport = runtime.raw?.({ protocol: 'openai-compatible', modelId: 'gpt-chat' });
    if (transport === undefined) throw new Error('missing GitHub Copilot raw transport');

    await transport.invoke(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-chat', messages: [] }),
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreGlobal('__AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__', clientId);
  }

  expect(calls.control).toEqual([]);
  expect(calls.model).toHaveLength(1);
  const request = calls.model[0];
  expect(request?.url).toBe('https://api.githubcopilot.com/v1/chat/completions');
  expect(request?.headers.get('authorization')).toBe('Bearer copilot-token');
  expect(request?.headers.get('copilot-integration-id')).toBe('vscode-chat');
  expect(request?.headers.get('editor-plugin-version')).toBe('copilot-chat/0.35.0');
  expect(request?.headers.get('editor-version')).toBe('vscode/1.107.0');
  expect(request?.headers.get('user-agent')).toBe('GitHubCopilotChat/0.35.0');
});

test('routes an expired credential refresh and final request through the host fetch', async () => {
  const originalFetch = globalThis.fetch;
  const clientId = Reflect.get(globalThis, '__AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__');
  const calls = fetchCalls();
  Reflect.set(globalThis, '__AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__', clientId ?? 'test-client-id');
  globalThis.fetch = async () => {
    throw new Error('unexpected global fetch');
  };

  try {
    const { createGitHubCopilotRuntime } = await import('./runtime');
    const credentials = createCredentialPort({
      githubToken: 'github-token',
      copilotToken: 'expired-copilot-token',
      expiresAt: 0,
      baseURL: 'https://stale.example',
    });
    const runtime = await createGitHubCopilotRuntime({
      credentials: credentials.port,
      options: { deploymentType: 'github.com' },
      catalog: catalog(),
      fetch: hostFetch(calls, async (traffic, request) => {
        if (traffic === 'control') {
          expect(request.url).toBe('https://api.github.com/copilot_internal/v2/token');
          expect(request.headers.get('authorization')).toBe('Bearer github-token');
          return Response.json({ token: 'refreshed-copilot-token', expires_at: 9_999_999_999 });
        }
        expect(request.headers.get('authorization')).toBe('Bearer refreshed-copilot-token');
        return Response.json({ ok: true });
      }),
    });
    const transport = runtime.raw?.({ protocol: 'openai-compatible', modelId: 'gpt-chat' });
    if (transport === undefined) throw new Error('missing GitHub Copilot raw transport');

    const response = await transport.invoke(
      new Request('http://localhost/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-chat', messages: [] }),
      }),
    );

    expect(await response.json()).toEqual({ ok: true });
  } finally {
    globalThis.fetch = originalFetch;
    restoreGlobal('__AIO_PROXY_GITHUB_COPILOT_CLIENT_ID__', clientId);
  }

  expect(calls.control.map(({ url }) => url)).toEqual(['https://api.github.com/copilot_internal/v2/token']);
  expect(calls.model.map(({ url }) => url)).toEqual(['https://api.githubcopilot.com/v1/chat/completions']);
});

type FetchTraffic = 'control' | 'model';

function fetchCalls(): Record<FetchTraffic, Request[]> {
  return { control: [], model: [] };
}

function hostFetch(
  calls: Record<FetchTraffic, Request[]>,
  respond: (traffic: FetchTraffic, request: Request) => Promise<Response>,
): RuntimeFetch {
  return (async (input: RequestInfo | URL, init?: RuntimeRequestInit) => {
    const traffic = init?.aioProxy?.traffic ?? 'model';
    const request = new Request(input, init);
    calls[traffic].push(request);
    return await respond(traffic, request);
  }) as RuntimeFetch;
}

function credentialPort(): CredentialPort<GitHubCopilotCredential> {
  const value = {
    githubToken: 'github-token',
    copilotToken: 'copilot-token',
    expiresAt: Date.now() + 60_000,
    baseURL: 'https://api.githubcopilot.com',
  };
  return {
    read: async () => ({ revision: 1, value }),
    refresh: async () => {
      throw new Error('valid credentials must not refresh');
    },
  };
}

function catalog(): ModelCatalog {
  return {
    language: [{ id: 'gpt-chat', extra: { protocol: 'openai-compatible' } }],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
}

function restoreGlobal(key: string, value: unknown): void {
  if (value === undefined) Reflect.deleteProperty(globalThis, key);
  else Reflect.set(globalThis, key, value);
}
