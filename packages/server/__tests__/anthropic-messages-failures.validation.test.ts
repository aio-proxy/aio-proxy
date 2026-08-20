import { afterEach, describe, expect, test } from 'bun:test';

import { type AiSdkProviderInstance, createAiSdkProvider } from '@aio-proxy/core';

import { createServer } from '#server-test-lifecycle';

import { createTempHomes, messagesRequest, textStream } from './anthropic-messages.test-support';

const homes = createTempHomes('aio-proxy-anthropic-usage-');
const tempHome = homes.tempHome;
afterEach(homes.cleanup);

describe('POST /v1/messages', () => {
  test('Given no matching alias When message is posted Then returns 404 Anthropic error envelope', async () => {
    // Given
    let invoked = false;
    const provider = {
      id: 'mock-ai',
      kind: 'ai-sdk',
      models: ['claude-sonnet-4-5'],
      alias: { 'claude-sonnet-4-5': { model: 'claude-sonnet-4-5', preserve: false } },
      invoke() {
        invoked = true;
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request('/v1/messages', {
      body: JSON.stringify({ ...messagesRequest, model: 'missing-model' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(404);
    expect(body).toEqual({
      type: 'error',
      error: {
        type: 'not_found_error',
        message: 'Model not found: missing-model',
      },
    });
    expect(invoked).toBe(false);
  });

  test.each([
    { thinking: { type: 'enabled', budget_tokens: 1023 }, max_tokens: 8192 },
    { thinking: { type: 'enabled', budget_tokens: 8192 }, max_tokens: 8192 },
    { thinking: { type: 'adaptive' }, max_tokens: 8192 },
  ])('Given invalid thinking %# When message is posted Then it fails before a provider attempt', async (invalid) => {
    let invoked = false;
    const provider = {
      id: 'mock-ai',
      kind: 'ai-sdk',
      models: ['claude-sonnet-4-5'],
      alias: { 'claude-sonnet-4-5': { model: 'claude-sonnet-4-5', preserve: false } },
      invoke() {
        invoked = true;
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      dbHome: tempHome(),
      providerInstances: [provider],
    });

    const response = await app.request('/v1/messages', {
      body: JSON.stringify({ ...messagesRequest, ...invalid }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'Invalid Anthropic Messages request' },
    });
    expect(invoked).toBe(false);
  });

  test('Given disabled thinking with effort When message is posted Then it is routed', async () => {
    let invoked = false;
    const provider = {
      id: 'mock-ai',
      kind: 'ai-sdk',
      models: ['claude-sonnet-4-5'],
      alias: { 'claude-sonnet-4-5': { model: 'claude-sonnet-4-5', preserve: false } },
      invoke() {
        invoked = true;
        return textStream([
          { type: 'text-start', id: 'text-1' },
          { type: 'text-end', id: 'text-1' },
          { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: {} },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      dbHome: tempHome(),
      providerInstances: [provider],
    });

    const response = await app.request('/v1/messages', {
      body: JSON.stringify({
        ...messagesRequest,
        thinking: { type: 'disabled' },
        output_config: { effort: 'high' },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    await response.text();

    expect(response.status).toBe(200);
    expect(invoked).toBe(true);
  });

  test('Given ai-sdk provider package is missing When stream message is posted Then Anthropic error is actionable 503 before SSE', async () => {
    // Given
    const provider = createAiSdkProvider(
      {
        kind: 'ai-sdk',
        id: 'missing-ai',
        packageName: '@vendor/missing-provider',
        models: ['claude-sonnet-4-5'],
        alias: { 'claude-sonnet-4-5': { model: 'claude-sonnet-4-5', preserve: false } },
      },
      {
        async loadProvider() {
          return null;
        },
      },
    );
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request('/v1/messages', {
      body: JSON.stringify(messagesRequest),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).not.toContain('text/event-stream');
    expect(body.error.type).toBe('invalid_request_error');
    expect(body.error.message).toContain('run aio-proxy plugin add @vendor/missing-provider');
  });
});
