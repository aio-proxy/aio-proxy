import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createAiSdkProvider } from '@aio-proxy/core';
import { createServer } from '@aio-proxy/server';

import { chatRequest, mockModelsDevCatalog, restoreFetch } from './openai-completions.test-support';

beforeEach(mockModelsDevCatalog);
afterEach(restoreFetch);

describe('POST /v1/chat/completions', () => {
  test('Given ai-sdk provider package is missing When non-stream completion is posted Then OpenAI error is actionable 503', async () => {
    // Given
    const provider = createAiSdkProvider(
      {
        kind: 'ai-sdk',
        id: 'missing-ai',
        packageName: '@vendor/missing-provider',
        models: ['gpt-4o-mini'],
        alias: { 'gpt-4o-mini': { model: 'gpt-4o-mini', preserve: false } },
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
    const response = await app.request('/v1/chat/completions', {
      body: JSON.stringify({ ...chatRequest, stream: false }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: {
        code: 'provider_not_installed',
        message:
          'missing-ai: ai-sdk provider package "@vendor/missing-provider" is not installed; run aio-proxy plugin add @vendor/missing-provider',
        type: 'invalid_request_error',
      },
    });
  });

  test('Given ai-sdk provider package is missing When stream completion is posted Then OpenAI error is actionable 503', async () => {
    // Given
    const provider = createAiSdkProvider(
      {
        kind: 'ai-sdk',
        id: 'missing-ai',
        packageName: '@vendor/missing-provider',
        models: ['gpt-4o-mini'],
        alias: { 'gpt-4o-mini': { model: 'gpt-4o-mini', preserve: false } },
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
    const response = await app.request('/v1/chat/completions', {
      body: JSON.stringify(chatRequest),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    // Then
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).not.toContain('text/event-stream');
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: 'provider_not_installed',
        message:
          'missing-ai: ai-sdk provider package "@vendor/missing-provider" is not installed; run aio-proxy plugin add @vendor/missing-provider',
        type: 'invalid_request_error',
      },
    });
  });
});
