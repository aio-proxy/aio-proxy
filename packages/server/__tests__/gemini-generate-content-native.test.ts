import { afterEach, describe, expect, test } from 'bun:test';

import { type ApiProviderInstance } from '@aio-proxy/core';
import { ProviderProtocol } from '@aio-proxy/types';
import type { TextStreamPart, ToolSet } from 'ai';

import { createServer } from '#server-test-lifecycle';

import {
  aiSdkProvider,
  appWith,
  createTempHomes,
  generateRequest,
  googleNativeProvider,
  postGenerate,
  postStream,
  recorded,
} from './gemini-generate-content.test-support';

const homes = createTempHomes('aio-proxy-gemini-usage-');
const tempHome = homes.tempHome;
afterEach(homes.cleanup);

describe('POST /v1beta/models/:model::generateContent', () => {
  test('Given caller API keys When Gemini content is posted Then a valid Bearer key is required', async () => {
    const provider = googleNativeProvider(async () => Response.json({ ok: true }));
    const app = await createServer({
      config: { server: { apiKeys: [{ key: 'caller-secret' }] }, providers: {} },
      dbHome: tempHome(),
      providerInstances: [provider],
    });

    const missing = await app.request('/v1beta/models/gemini-2.5-flash:generateContent', {
      body: JSON.stringify(generateRequest),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const authorized = await app.request('/v1beta/models/gemini-2.5-flash:generateContent', {
      body: JSON.stringify(generateRequest),
      headers: { authorization: 'Bearer caller-secret', 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(missing.status).toBe(401);
    expect(authorized.status).toBe(200);
  });

  test('Given gemini api provider When generateContent is posted Then passthrough receives original bytes', async () => {
    // Given
    const requestBody = JSON.stringify(generateRequest);
    let bodySeen = '';
    const provider = googleNativeProvider(async (req) => {
      bodySeen = await req.text();
      return new Response('provider-bytes', {
        headers: { 'x-provider': 'google' },
        status: 202,
      });
    });
    const dbHome = tempHome();
    const app = await appWith(provider, dbHome);

    // When
    const response = await postGenerate(app, requestBody);

    // Then
    expect(response.status).toBe(202);
    expect(response.headers.get('x-provider')).toBe('google');
    expect(await response.text()).toBe('provider-bytes');
    expect(bodySeen).toBe(requestBody);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          inboundProtocol: ProviderProtocol.Gemini,
          requestedModelId: 'gemini-2.5-flash',
          finalProviderId: 'google',
          finalModelId: 'gemini-2.5-flash',
          outcome: 'success',
          attempts: [expect.objectContaining({ index: 0, providerId: 'google', outcome: 'success' })],
        }),
      ],
      usages: [],
    });
  });

  test('Given first native provider throws When generateContent is posted Then next provider is used', async () => {
    const first = googleNativeProvider(async () => {
      throw new Error('connection refused');
    });
    const second = {
      ...googleNativeProvider(async () => Response.json({ fallback: true })),
      id: 'google-fallback',
    } satisfies ApiProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [first, second] });

    const response = await postGenerate(app);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fallback: true });
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          attempts: [
            expect.objectContaining({ index: 0, providerId: 'google', outcome: 'failure' }),
            expect.objectContaining({ index: 1, providerId: 'google-fallback', outcome: 'success' }),
          ],
          outcome: 'success',
        }),
      ],
      usages: [],
    });
  });

  test('Given stream emits data then errors When streamGenerateContent runs Then request is failure', async () => {
    const provider = aiSdkProvider(
      () =>
        new ReadableStream<TextStreamPart<ToolSet>>({
          start(controller) {
            controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'partial' });
            controller.error(new Error('stream broke'));
          },
        }),
    );
    const dbHome = tempHome();
    const app = await appWith(provider, dbHome);

    const response = await postStream(app);
    await response.text();
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({ outcome: 'failure', attempts: [expect.objectContaining({ outcome: 'failure' })] }),
      ],
      usages: [],
    });
  });
});
