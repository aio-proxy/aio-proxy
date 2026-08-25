import { describe, expect, test } from 'bun:test';

import { createServer } from '#server-test-lifecycle';

import {
  aiSdkProvider,
  responsesRequest,
  textStream,
  unsupportedBeforeProviderInvocationCases,
  unsupportedEnvelope,
} from '../../__tests__/openai-responses.test-support';

describe('OpenAI Responses routes', () => {
  for (const scenario of unsupportedBeforeProviderInvocationCases) {
    test(`Given ${scenario.name} When POST is requested Then unsupported feature is returned before provider invocation`, async () => {
      let invoked = false;
      const provider = aiSdkProvider(() => {
        invoked = true;
        return textStream([]);
      });
      const app = await createServer({
        config: { providers: {} },
        providerInstances: [provider],
      });

      const response = await app.request('/v1/responses', {
        body: JSON.stringify(scenario.body),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

      expect(response.status).toBe(501);
      expect(await response.json()).toEqual(unsupportedEnvelope(scenario.feature));
      expect(invoked).toBe(false);
    });
  }

  test('Given forbidden built-in tool When POST is requested Then unsupported feature is returned', async () => {
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    const response = await app.request('/v1/responses', {
      body: JSON.stringify({
        ...responsesRequest,
        tools: [{ type: 'web_search_preview' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual(unsupportedEnvelope('web_search_preview'));
    expect(invoked).toBe(false);
  });

  test('Given stored response id When GET is requested Then retrieval is unsupported', async () => {
    const app = await createServer({ config: { providers: {} } });

    const response = await app.request('/v1/responses/resp-1');

    expect(response.status).toBe(501);
    expect(await response.json()).toEqual(unsupportedEnvelope('response_retrieval'));
  });

  test.each([
    ['DELETE', '/v1/responses/resp-1', 'response_delete'],
    ['POST', '/v1/responses/resp-1/cancel', 'response_cancel'],
    ['GET', '/v1/responses/resp-1/input_items', 'response_input_items'],
  ] as const)('Given %s %s When requested Then %s is 501 without a provider', async (method, path, feature) => {
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });
    const response = await app.request(path, { method });
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual(unsupportedEnvelope(feature));
    expect(invoked).toBe(false);
  });

  test('Given GET /v1/responses When requested Then the list path stays unregistered', async () => {
    const app = await createServer({ config: { providers: {} } });
    const response = await app.request('/v1/responses');
    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain('response_list');
  });

  test('Given compact model null When POST is requested Then invalid request is returned before provider invocation', async () => {
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });
    const response = await app.request('/v1/responses/compact', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: null, input: null }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_request', type: 'invalid_request_error' },
    });
    expect(invoked).toBe(false);
  });

  test('Given malformed JSON When POST is requested Then invalid request is returned before provider invocation', async () => {
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    const response = await app.request('/v1/responses', {
      body: '{',
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: 'invalid_request',
        message: 'Invalid OpenAI Responses request',
        type: 'invalid_request_error',
      },
    });
    expect(invoked).toBe(false);
  });
});
