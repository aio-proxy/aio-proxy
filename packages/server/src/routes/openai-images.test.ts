import { expect, test } from 'bun:test';

import { openAIImagesAdapter, REQUEST_BODY_LIMITS } from '@aio-proxy/core';
import { ProviderKind } from '@aio-proxy/types';

import { createServer } from '#server-test-lifecycle';

import type { ImageTransportInvokeRequest, RuntimeProviderInstance } from '../runtime';
import { hasInvalidOrOversizedContentLength } from './pipeline/request';

const edits = { operation: 'edits' as const };
const officialMax = { encoded: 357_564_416, decoded: 357_564_416 };

test('official-max Content-Length is accepted for edits JSON and rejected by language limits', () => {
  const raw = new Request('https://x/v1/images/edits', {
    method: 'POST',
    headers: { 'content-length': '357564416', 'content-type': 'application/json' },
    body: '{}',
  });
  expect(openAIImagesAdapter.bodyLimits(raw, edits)).toEqual(officialMax);
  expect(hasInvalidOrOversizedContentLength(raw, officialMax)).toBe(false);
  expect(hasInvalidOrOversizedContentLength(raw, REQUEST_BODY_LIMITS)).toBe(true);
});

test('POST /v1/images/variations stays 404', async () => {
  const app = await createServer({ config: { providers: {} } });
  const response = await app.request('/v1/images/variations', {
    body: JSON.stringify({ model: 'gpt-image-2', prompt: 'a cat' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  expect(response.status).toBe(404);
});

test('POST /v1/images/edits exists and rejects multipart as 415 or 400', async () => {
  const app = await createServer({ config: { providers: {} } });
  const response = await app.request('/v1/images/edits', {
    body: '--bound\r\nContent-Disposition: form-data; name="prompt"\r\n\r\nnight\r\n--bound--',
    headers: { 'content-type': 'multipart/form-data; boundary=bound' },
    method: 'POST',
  });
  expect(response.status).not.toBe(404);
  expect([400, 415]).toContain(response.status);
});

test('POST /v1/images/edits convert 501s JSON image_url', async () => {
  const app = await createServer({
    config: { providers: {} },
    providerInstances: [imageConvertOnly('gpt-image-2')],
  });
  const response = await app.request('/v1/images/edits', {
    body: JSON.stringify({
      model: 'gpt-image-2',
      prompt: 'make it night',
      images: [{ image_url: 'https://example.com/cat.png' }],
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  expect(response.status).toBe(501);
  expect(await response.json()).toMatchObject({
    error: { code: 'unsupported_feature', type: 'invalid_request_error' },
  });
});

function imageConvertOnly(modelId: string): RuntimeProviderInstance {
  return {
    capabilityIndex: { [modelId]: new Set(['image']) },
    enabled: true,
    id: 'convert',
    image: {
      invoke: async (_request: ImageTransportInvokeRequest) => ({ images: [new Uint8Array([1])] }),
    },
    kind: ProviderKind.AiSdk,
    models: [modelId],
  };
}
