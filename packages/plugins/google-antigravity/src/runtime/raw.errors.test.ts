import { describe, expect, test } from 'bun:test';

import { createGeminiRawResolver } from './raw';
import { credentialSource, geminiRequest, logicalContext, resolve } from './raw.test-support';
import { AntigravityTransport } from './transport';

describe('Gemini raw resolver', () => {
  test('returns standard Gemini errors without upstream body disclosure', async () => {
    const resolver = createGeminiRawResolver({
      execute: async () => Response.json({ raw: 'upstream-secret' }, { status: 400 }),
    });

    const response = await resolve(resolver, 'gemini')?.invoke(geminiRequest('generateContent', {}), logicalContext());

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: { code: 400, message: 'Google Antigravity request failed', status: 'INVALID_ARGUMENT' },
    });
  });

  test('returns a protocol-shaped 400 without sending an invalid function declaration', async () => {
    let sent = false;
    const resolver = createGeminiRawResolver(
      new AntigravityTransport({
        credentials: credentialSource(),
        fetch: async () => {
          sent = true;
          return Response.json({ response: {} });
        },
      }),
    );

    const response = await resolve(resolver, 'gemini')?.invoke(
      geminiRequest('generateContent', {
        tools: [{ functionDeclarations: [{ name: 'invalid', parametersJsonSchema: null }] }],
      }),
      logicalContext(),
    );

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: { code: 400, message: 'Google Antigravity request failed', status: 'INVALID_ARGUMENT' },
    });
    expect(sent).toBe(false);
  });

  test('does not forward inbound cookies, request IDs, or fingerprints', async () => {
    let headers = new Headers();
    const resolver = createGeminiRawResolver(
      new AntigravityTransport({
        credentials: credentialSource(),
        fetch: async (input, init) => {
          headers = new Request(input, init).headers;
          return Response.json({ response: {} });
        },
      }),
    );
    const request = geminiRequest(
      'generateContent',
      {},
      {
        Cookie: 'session=inbound-secret',
        'X-Client-Request-Id': 'client-request-secret',
        'X-Stainless-Runtime': 'browser-fingerprint',
      },
    );

    await resolve(resolver, 'gemini')?.invoke(request, logicalContext());

    expect([...headers.keys()]).not.toContain('cookie');
    expect([...headers.keys()]).not.toContain('x-client-request-id');
    expect([...headers.keys()]).not.toContain('x-stainless-runtime');
  });
});
