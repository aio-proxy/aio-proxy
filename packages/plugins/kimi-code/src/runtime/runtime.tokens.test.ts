import { describe, expect, test } from 'bun:test';

import { createKimiDynamicFetch, createKimiRuntime } from './runtime';
import {
  catalog,
  context,
  credentialPort,
  logicalContext,
  tokenCountInput,
  validCredential,
} from './runtime.test-support';

describe('Kimi Code runtime', () => {
  test('counts Anthropic input tokens natively with the resolved model', async () => {
    let captured: Request | undefined;
    let signal: AbortSignal | null | undefined;
    const runtime = await createKimiRuntime(context(validCredential('count-token'), catalog()), {
      fetch: async (input, init) => {
        captured = new Request(input, init);
        signal = init?.signal;
        return Response.json({ input_tokens: 17 });
      },
    });
    const controller = new AbortController();

    const result = await runtime.tokenCount?.countTokens({
      protocol: 'anthropic',
      modelId: 'resolved-model',
      request: new Request('http://localhost/v1/messages/count_tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client': 'kept', 'x-api-key': 'client-secret' },
        body: JSON.stringify({ model: 'client-model', messages: [] }),
        signal: controller.signal,
      }),
      context: logicalContext(),
      invocation: { messages: [] },
    });

    expect(result).toEqual({ inputTokens: 17 });
    expect(captured?.url).toBe('https://api.kimi.com/coding/v1/messages/count_tokens?beta=true');
    expect(signal).toBe(controller.signal);
    expect(captured?.headers.get('x-client')).toBe('kept');
    expect(captured?.headers.get('authorization')).toBe('Bearer count-token');
    expect(captured?.headers.get('x-api-key')).toBeNull();
    expect(await captured?.json()).toEqual({ model: 'resolved-model', messages: [] });
  });

  test('rejects unsupported token-count protocols and invalid upstream counts', async () => {
    let response: unknown = { input_tokens: -1 };
    let calls = 0;
    const runtime = await createKimiRuntime(context(validCredential(), catalog()), {
      fetch: async () => {
        calls += 1;
        return Response.json(response);
      },
    });
    await expect(runtime.tokenCount?.countTokens(tokenCountInput('openai-compatible'))).rejects.toThrow(
      'does not support openai-compatible',
    );
    expect(calls).toBe(0);
    for (response of [{ input_tokens: -1 }, { input_tokens: 1.5 }, { input_tokens: Number.MAX_SAFE_INTEGER + 1 }, {}]) {
      await expect(runtime.tokenCount?.countTokens(tokenCountInput('anthropic'))).rejects.toThrow(
        'response is invalid',
      );
    }
  });

  test('dynamic fetch refreshes credentials and never forwards client credentials', async () => {
    const credentials = credentialPort({ ...validCredential('expired-token'), expiresAt: 0 });
    const calls: Request[] = [];
    const fetcher = createKimiDynamicFetch(credentials, {
      now: () => 1_000,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        calls.push(request);
        if (request.url.includes('/oauth/token')) {
          return Response.json({ access_token: 'refreshed-token', refresh_token: 'new-refresh', expires_in: 3600 });
        }
        return Response.json({ ok: true });
      },
    });

    await fetcher('https://api.kimi.com/coding/v1/messages', {
      method: 'POST',
      headers: {
        authorization: 'Bearer client-secret',
        'x-api-key': 'placeholder',
        'anthropic-api-key': 'placeholder',
      },
      body: '{}',
    });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer refreshed-token');
    expect(calls[1]?.headers.get('x-api-key')).toBeNull();
    expect(calls[1]?.headers.get('anthropic-api-key')).toBeNull();
    expect(credentials.current().accessToken).toBe('refreshed-token');
  });
});
