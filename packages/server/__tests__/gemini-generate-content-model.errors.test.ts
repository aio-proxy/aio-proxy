import { describe, expect, test } from 'bun:test';

import { REQUEST_BODY_LIMITS } from '@aio-proxy/core';

import {
  aiSdkProvider,
  appWith,
  generateRequest,
  jsonHeaders,
  postGenerate,
  textStream,
} from './gemini-generate-content.test-support';

describe('POST /v1beta/models/:model::generateContent', () => {
  test('Given no matching alias When generateContent is posted Then returns 404 Gemini error envelope', async () => {
    // Given
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = await appWith(provider);

    // When
    const response = await postGenerate(app, generateRequest, 'missing-model');
    const body = await response.json();

    // Then
    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: {
        code: 404,
        message: 'Model not found: missing-model',
        status: 'NOT_FOUND',
      },
    });
    expect(invoked).toBe(false);
  });

  test('Given forged oversized Content-Length When generateContent is posted Then returns 413 before provider invocation', async () => {
    // Given
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = await appWith(provider);

    // When
    const response = await app.request('/v1beta/models/gemini-2.5-flash:generateContent', {
      body: JSON.stringify(generateRequest),
      headers: {
        ...jsonHeaders,
        'content-length': String(REQUEST_BODY_LIMITS.encoded + 1),
      },
      method: 'POST',
    });

    // Then
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: 413,
        message: 'Request body too large',
        status: 'RESOURCE_EXHAUSTED',
      },
    });
    expect(invoked).toBe(false);
  });

  test('Given oversized inlineData When generateContent is posted Then returns 413 Gemini error envelope', async () => {
    // Given
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = await appWith(provider);
    const data = 'A'.repeat(27_962_028);

    // When
    const response = await postGenerate(app, {
      contents: [
        {
          parts: [{ inlineData: { mimeType: 'image/png', data } }],
        },
      ],
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(413);
    expect(body).toEqual({
      error: {
        code: 413,
        message: 'Gemini inlineData at contents.0.parts.0.inlineData.data is 20971521 bytes; limit is 20971520',
        status: 'RESOURCE_EXHAUSTED',
      },
    });
    expect(invoked).toBe(false);
  });
});
