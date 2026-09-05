import { describe, expect, test } from 'bun:test';

import type { CredentialPort } from '@aio-proxy/plugin-sdk';

import { CHATGPT_USER_AGENT, createOpenAIChatGPTDynamicFetch, createOpenAIChatGPTRuntime, currentCredential } from '.';
import type { ChatGPTCredential } from '../schema';

type FetchCall = {
  readonly body: string;
  readonly decompress: boolean | undefined;
  readonly headers: Headers;
  readonly signal: AbortSignal | null | undefined;
  readonly url: string;
};

describe('OpenAI ChatGPT runtime', () => {
  test('returns a ProviderV4 with same-protocol raw capability only', async () => {
    const runtime = await createOpenAIChatGPTRuntime({
      credentials: staticCredentialPort(credential()),
      options: {},
      catalog: emptyCatalog(),
    });

    expect(runtime.provider.specificationVersion).toBe('v4');
    expect(runtime.provider.languageModel('gpt-5.5')).toBeDefined();
    expect(runtime.raw?.({ protocol: 'openai-response', modelId: 'gpt-5.5' })).toBeDefined();
    expect(runtime.raw?.({ protocol: 'openai-image', modelId: 'gpt-image-2' })).toBeDefined();
    expect(runtime.raw?.({ protocol: 'gemini-interactions', modelId: 'gpt-5.5' })).toBeUndefined();
    expect(runtime.raw?.({ protocol: 'openai-compatible', modelId: 'gpt-5.5' })).toBeUndefined();
    expect(runtime.raw?.({ protocol: 'anthropic', modelId: 'gpt-5.5' })).toBeUndefined();
    expect(runtime.raw?.({ protocol: 'gemini', modelId: 'gpt-5.5' })).toBeUndefined();
    expect(runtime.raw?.({ protocol: 'openai-response', modelId: 'gpt-5.5', capability: 'embedding' })).toBeUndefined();
    expect(
      runtime.raw?.({ protocol: 'openai-compatible', modelId: 'gpt-5.5', capability: 'embedding' }),
    ).toBeUndefined();
  });

  test('routes every concurrent expired request through the host credential refresh port', async () => {
    const calls: FetchCall[] = [];
    let refreshCalls = 0;
    const expired = credential({ accessToken: 'expired', expiresAt: Date.now() - 1 });
    const fresh = credential({ accessToken: 'fresh', expiresAt: Date.now() + 60_000 });
    const credentials: CredentialPort<ChatGPTCredential> = {
      read: async () => ({ revision: 3, value: expired }),
      refresh: async (revision) => {
        refreshCalls += 1;
        expect(revision).toBe(3);
        return { status: 'updated', snapshot: { revision: 4, value: fresh } };
      },
    };
    const dynamicFetch = createOpenAIChatGPTDynamicFetch(credentials, captureFetch(calls));

    await Promise.all([
      dynamicFetch('https://api.openai.com/v1/responses', { method: 'POST' }),
      dynamicFetch('https://api.openai.com/v1/responses', { method: 'POST' }),
    ]);

    expect(refreshCalls).toBe(2);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.headers.get('authorization') === 'Bearer fresh')).toBe(true);
  });

  test('returns refreshed expiry metadata to the host credential port', async () => {
    const originalFetch = globalThis.fetch;
    let metadata: { readonly expiresAt?: number } | undefined;
    const expired = credential({ accessToken: 'expired', expiresAt: 0 });
    const credentials: CredentialPort<ChatGPTCredential> = {
      read: async () => ({ revision: 3, value: expired }),
      refresh: async (revision, exchange) => {
        const exchanged = await exchange({ revision, value: expired }, new AbortController().signal);
        metadata = exchanged.metadata;
        return { status: 'updated', snapshot: { revision: revision + 1, value: exchanged.value } };
      },
    };
    globalThis.fetch = async () =>
      Response.json({ access_token: buildJwt({ chatgpt_account_id: 'acct-refreshed' }), expires_in: 60 });

    try {
      const refreshed = await currentCredential(credentials);
      expect(metadata).toEqual({ expiresAt: refreshed.expiresAt });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('replaces caller auth, injects ChatGPT headers, and rewrites Codex paths', async () => {
    const calls: FetchCall[] = [];
    const dynamicFetch = createOpenAIChatGPTDynamicFetch(
      staticCredentialPort(credential({ accessToken: 'runtime-token' })),
      captureFetch(calls),
    );
    const controller = new AbortController();

    const body = JSON.stringify({
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      model: 'gpt-5.5',
      store: false,
      stream: true,
    });
    await dynamicFetch('https://api.openai.com/v1/responses?foo=bar&foo=baz', {
      body,
      headers: {
        authorization: 'Bearer caller-token',
        'accept-encoding': 'br',
        host: '127.0.0.1:22078',
        'x-keep': '1',
      },
      method: 'POST',
      signal: controller.signal,
    });
    await dynamicFetch('https://api.openai.com/v1/chat/completions', { method: 'POST' });
    await dynamicFetch('https://api.openai.com/v1/models', { method: 'GET' });

    const first = requiredCall(calls, 0);
    expect(first.url).toBe('https://chatgpt.com/backend-api/codex/responses?foo=bar&foo=baz');
    expect(requiredCall(calls, 1).url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect(requiredCall(calls, 2).url).toBe('https://api.openai.com/v1/models');
    expect(first.headers.get('authorization')).toBe('Bearer runtime-token');
    expect(first.headers.get('ChatGPT-Account-Id')).toBe('acct-123');
    expect(first.headers.get('Originator')).toBe('codex-tui');
    expect(first.headers.get('User-Agent')).toBe(CHATGPT_USER_AGENT);
    expect(first.headers.get('session-id')).toBeString();
    expect(first.headers.get('host')).toBeNull();
    expect(first.headers.get('x-keep')).toBe('1');
    expect(first.headers.get('accept-encoding')).toBe('identity');
    expect(first.decompress).toBe(false);
    expect(first.body).toBe(body);
    expect(first.signal).toBe(controller.signal);
    expect(requiredCall(calls, 1).headers.get('session-id')).not.toBe(first.headers.get('session-id'));
  });
});

test('refresh metadata uses stored email when rotated tokens omit one', async () => {
  const originalFetch = globalThis.fetch;
  let metadata: { readonly accountLabel?: string; readonly expiresAt?: number } | undefined;
  const expired = credential({ accessToken: 'expired', expiresAt: 0, email: 'stored@example.com' });
  const credentials: CredentialPort<ChatGPTCredential> = {
    read: async () => ({ revision: 3, value: expired }),
    refresh: async (revision, exchange) => {
      const exchanged = await exchange({ revision, value: expired }, new AbortController().signal);
      metadata = exchanged.metadata;
      return { status: 'updated', snapshot: { revision: revision + 1, value: exchanged.value } };
    },
  };
  globalThis.fetch = async () =>
    Response.json({ access_token: buildJwt({ chatgpt_account_id: 'acct-refreshed' }), expires_in: 60 });

  try {
    const refreshed = await currentCredential(credentials);
    expect(refreshed.email).toBe('stored@example.com');
    expect(metadata).toEqual({ accountLabel: 'stored@example.com', expiresAt: refreshed.expiresAt });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('normalizes Responses requests for the Codex backend', async () => {
  const calls: FetchCall[] = [];
  const dynamicFetch = createOpenAIChatGPTDynamicFetch(staticCredentialPort(credential()), captureFetch(calls));

  await dynamicFetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'content-encoding': 'identity',
      'content-length': '1',
    },
    body: JSON.stringify({ model: 'gpt-5.6-luna', input: 'hello', store: true, stream: true }),
  });

  const call = requiredCall(calls, 0);
  expect(JSON.parse(call.body)).toEqual({
    model: 'gpt-5.6-luna',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    store: false,
    stream: true,
  });
  expect(call.headers.get('content-encoding')).toBeNull();
  expect(call.headers.get('content-length')).toBeNull();
});

// The Codex backend persists nothing, so a reasoning item whose only handle is
// an id — the shape this proxy's own AI SDK egress mints — answers with
// "Item with id 'rs_…' not found" on the next turn.
test('drops a reasoning id the Codex backend never persisted', async () => {
  const calls: FetchCall[] = [];
  const dynamicFetch = createOpenAIChatGPTDynamicFetch(staticCredentialPort(credential()), captureFetch(calls));

  await dynamicFetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    body: JSON.stringify({
      model: 'gpt-5.6-luna',
      input: [
        {
          type: 'reasoning',
          id: 'rs_resp_ab454c48-a211-44b7-b0af-15e95f510490_0',
          summary: [{ type: 'summary_text', text: 'Checked the weather.' }],
        },
        { type: 'reasoning', id: 'rs_2', encrypted_content: 'blob', summary: [] },
        { role: 'user', content: 'And tomorrow?' },
      ],
    }),
  });

  expect(JSON.parse(requiredCall(calls, 0).body)).toEqual({
    model: 'gpt-5.6-luna',
    store: false,
    input: [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'Checked the weather.' }] },
      { type: 'reasoning', id: 'rs_2', encrypted_content: 'blob', summary: [] },
      { role: 'user', content: 'And tomorrow?' },
    ],
  });
});

test('routes compact to the Codex compaction endpoint and forwards its body verbatim', async () => {
  const calls: FetchCall[] = [];
  const dynamicFetch = createOpenAIChatGPTDynamicFetch(staticCredentialPort(credential()), captureFetch(calls));
  const body = JSON.stringify({
    model: 'gpt-5.1-codex-max',
    instructions: 'summarize',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
  });

  await dynamicFetch('https://proxy.local/v1/responses/compact?trace=1', { method: 'POST', body });

  const call = requiredCall(calls, 0);
  expect(call.url).toBe('https://chatgpt.com/backend-api/codex/responses/compact?trace=1');
  expect(call.body).toBe(body);
});

test('routes image generations and edits to the Codex image endpoints', async () => {
  const calls: FetchCall[] = [];
  const dynamicFetch = createOpenAIChatGPTDynamicFetch(staticCredentialPort(credential()), captureFetch(calls));
  const body = JSON.stringify({ model: 'gpt-image-2', prompt: 'a tiny red square' });

  await dynamicFetch('https://proxy.local/v1/images/generations?trace=1', { method: 'POST', body });
  await dynamicFetch('https://proxy.local/v1/images/edits', { method: 'POST', body });

  expect(requiredCall(calls, 0).url).toBe('https://chatgpt.com/backend-api/codex/images/generations?trace=1');
  expect(requiredCall(calls, 1).url).toBe('https://chatgpt.com/backend-api/codex/images/edits');
  // Image bodies are forwarded verbatim: the `store: false` rewrite is
  // Responses-only, and the Codex image endpoints reject unknown parameters.
  expect(requiredCall(calls, 0).body).toBe(body);
  expect(requiredCall(calls, 0).headers.get('authorization')).toBe('Bearer access-token');
  expect(requiredCall(calls, 0).headers.get('ChatGPT-Account-Id')).toBe('acct-123');
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

function buildJwt(payload: object): string {
  return ['header', Buffer.from(JSON.stringify(payload)).toString('base64url'), 'signature'].join('.');
}

function staticCredentialPort(value: ChatGPTCredential): CredentialPort<ChatGPTCredential> {
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

function captureFetch(calls: FetchCall[]): typeof fetch {
  return async (input, init) => {
    const decompress = (init as { decompress?: boolean } | undefined)?.decompress;
    const request = new Request(input, init);
    calls.push({
      body: await request.text(),
      decompress,
      headers: new Headers(request.headers),
      signal: init?.signal ?? request.signal,
      url: request.url,
    });
    return new Response('', { status: 200 });
  };
}

function requiredCall(calls: readonly FetchCall[], index: number): FetchCall {
  const call = calls[index];
  if (call === undefined) throw new Error(`missing fetch call ${index}`);
  return call;
}
