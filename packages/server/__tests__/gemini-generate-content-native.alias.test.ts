import { describe, expect, test } from 'bun:test';

import { type ApiProviderInstance } from '@aio-proxy/core';
import { ProviderProtocol } from '@aio-proxy/types';

import { appWith, generateRequest, googleNativeProvider, postGenerate } from './gemini-generate-content.test-support';

describe('POST /v1beta/models/:model::generateContent', () => {
  test('Given an alias variant and native provider When generateContent is posted Then passthrough uses the variant path', async () => {
    // Given
    let pathnameSeen = '';
    let bodySeen = '';
    const passthrough = async (req: Request) => {
      pathnameSeen = new URL(req.url).pathname;
      bodySeen = await req.text();
      return Response.json({ ok: true });
    };
    const provider = {
      id: 'google',
      kind: 'api',
      models: ['gemini-default', 'gemini-high'],
      alias: {
        'gemini-alias': {
          model: 'gemini-default',
          preserve: false,
          variants: { high: { model: 'gemini-high', preserve: false } },
        },
      },
      protocol: ProviderProtocol.Gemini,
      endpointTransports: [{ protocol: ProviderProtocol.Gemini, passthrough }],
      passthrough,
    } satisfies ApiProviderInstance;
    const app = await appWith(provider);
    const body = {
      ...generateRequest,
      generationConfig: { thinkingConfig: { thinkingLevel: 'HIGH' } },
    };

    // When
    const response = await postGenerate(app, body, 'gemini-alias');

    // Then
    expect(response.status).toBe(200);
    expect(pathnameSeen).toBe('/v1beta/models/gemini-high:generateContent');
    expect(JSON.parse(bodySeen)).toEqual(body);
  });

  test('Given gemini oversized inlineData When generateContent is posted Then returns 413 without passthrough', async () => {
    // Given
    let invoked = false;
    const provider = googleNativeProvider(async () => {
      invoked = true;
      return new Response('provider-invoked', { status: 202 });
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
    expect(body).toMatchObject({
      error: {
        code: 413,
        message: 'Gemini inlineData at contents.0.parts.0.inlineData.data is 20971521 bytes; limit is 20971520',
        status: 'RESOURCE_EXHAUSTED',
      },
    });
    expect(invoked).toBe(false);
  });
});
