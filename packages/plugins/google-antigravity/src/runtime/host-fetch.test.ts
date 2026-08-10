import { expect, test } from 'bun:test';

import type { CredentialPort, LogicalRequestContext, RuntimeFetch, RuntimeRequestInit } from '@aio-proxy/plugin-sdk';

import type { GoogleAntigravityCredential } from '../schema';

test('routes the final Google Antigravity request through the host fetch', async () => {
  const originalFetch = globalThis.fetch;
  const clientId = Reflect.get(globalThis, '__AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_ID__');
  const clientSecret = Reflect.get(globalThis, '__AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_SECRET__');
  const requests: Request[] = [];
  Reflect.set(globalThis, '__AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_ID__', clientId ?? 'test-client-id');
  Reflect.set(globalThis, '__AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_SECRET__', clientSecret ?? 'test-client-secret');
  globalThis.fetch = async () => {
    throw new Error('unexpected global fetch');
  };

  try {
    const { createGoogleAntigravityRuntime } = await import('./provider');
    const runtime = createGoogleAntigravityRuntime({
      credentials: credentialPort(),
      options: {},
      catalog: emptyCatalog(),
      fetch: async (input, init) => {
        requests.push(new Request(input, init));
        return Response.json({ response: {} });
      },
    });
    const transport = runtime.raw?.({ protocol: 'gemini', modelId: 'gemini-3-flash-agent' });
    if (transport === undefined) throw new Error('missing Google Antigravity raw transport');

    await transport.invoke(
      new Request('http://localhost/v1beta/models/gemini-3-flash-agent:generateContent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      logicalContext(),
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreGlobal('__AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_ID__', clientId);
    restoreGlobal('__AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_SECRET__', clientSecret);
  }

  expect(requests).toHaveLength(1);
  const request = requests[0];
  expect(request?.url).toContain('cloudcode-pa.googleapis.com');
  expect(request?.headers.get('authorization')).toBe('Bearer access-token');
  expect(request?.headers.get('x-goog-api-client')).toBe('gl-node/22.21.1');
  expect(request?.headers.get('user-agent')).toContain('antigravity/hub/');
});

test('classifies refresh as control traffic before the Google Antigravity request', async () => {
  const originalFetch = globalThis.fetch;
  const clientId = Reflect.get(globalThis, '__AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_ID__');
  const clientSecret = Reflect.get(globalThis, '__AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_SECRET__');
  const calls: { traffic: 'control' | 'model'; request: Request }[] = [];
  Reflect.set(globalThis, '__AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_ID__', clientId ?? 'test-client-id');
  Reflect.set(globalThis, '__AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_SECRET__', clientSecret ?? 'test-client-secret');
  globalThis.fetch = async () => {
    throw new Error('unexpected global fetch');
  };

  try {
    const { createGoogleAntigravityRuntime } = await import('./provider');
    const fetch: RuntimeFetch = async (input, init) => {
      const traffic = (init as RuntimeRequestInit | undefined)?.aioProxy?.traffic ?? 'model';
      calls.push({ traffic, request: new Request(input, init) });
      if (new URL(calls.at(-1)?.request.url ?? '').origin === 'https://oauth2.googleapis.com') {
        return Response.json({ access_token: 'refreshed-access-token', expires_in: 3600 });
      }
      return Response.json({ response: {} });
    };
    const runtime = createGoogleAntigravityRuntime({
      credentials: expiredCredentialPort(),
      options: {},
      catalog: emptyCatalog(),
      fetch,
    });
    const transport = runtime.raw?.({ protocol: 'gemini', modelId: 'gemini-3-flash-agent' });
    if (transport === undefined) throw new Error('missing Google Antigravity raw transport');

    await transport.invoke(
      new Request('http://localhost/v1beta/models/gemini-3-flash-agent:generateContent', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }),
      logicalContext(),
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreGlobal('__AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_ID__', clientId);
    restoreGlobal('__AIO_PROXY_GOOGLE_ANTIGRAVITY_CLIENT_SECRET__', clientSecret);
  }

  expect(calls.map(({ traffic }) => traffic)).toEqual(['control', 'model']);
  expect(calls[1]?.request.headers.get('authorization')).toBe('Bearer refreshed-access-token');
});

function credentialPort(): CredentialPort<GoogleAntigravityCredential> {
  const value = {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: 4_000_000_000_000,
    email: 'person@example.com',
    projectId: 'project-1',
  };
  return {
    read: async () => ({ revision: 1, value }),
    refresh: async () => {
      throw new Error('valid credentials must not refresh');
    },
  };
}

function expiredCredentialPort(): CredentialPort<GoogleAntigravityCredential> {
  const value = {
    accessToken: 'expired-access-token',
    refreshToken: 'refresh-token',
    expiresAt: 0,
    email: 'person@example.com',
    projectId: 'project-1',
  };
  return {
    read: async () => ({ revision: 1, value }),
    refresh: async (revision, exchange) => {
      const refreshed = await exchange({ revision, value }, new AbortController().signal);
      return { status: 'updated', snapshot: { revision: revision + 1, value: refreshed.value } };
    },
  };
}

function logicalContext(): LogicalRequestContext {
  return {
    requestId: '00000000-0000-4000-8000-000000000001',
    session: { key: 'sha256:host-fetch', source: 'transcript' },
  };
}

function emptyCatalog() {
  return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
}

function restoreGlobal(key: string, value: unknown): void {
  if (value === undefined) Reflect.deleteProperty(globalThis, key);
  else Reflect.set(globalThis, key, value);
}
