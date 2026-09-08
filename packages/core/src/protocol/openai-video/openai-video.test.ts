import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { openAIVideosAdapter } from './openai-video';

describe('openAIVideosAdapter', () => {
  test('is a video adapter on the openai-video protocol', () => {
    expect(openAIVideosAdapter.capability).toBe('video');
    expect(openAIVideosAdapter.protocol).toBe(ProviderProtocol.OpenAIVideo);
    expect(
      openAIVideosAdapter.convertSkipReason?.({ model: 'sora-2', prompt: 'x', modelDefaulted: true }, 'sora-2'),
    ).toBe('video_convert');
  });

  test('omitted model looks up sora-2 and raw injects the resolved id', async () => {
    const raw = new Request('http://x/v1/videos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat' }),
    });
    const request = await openAIVideosAdapter.parse(raw, { operation: 'create' });
    expect(request.model).toBe('sora-2');
    expect(request.modelDefaulted).toBe(true);
    const rewritten = await openAIVideosAdapter.rawRequest(raw, request, 'sora-2', new Set(), { operation: 'create' });
    expect(await rewritten.json()).toEqual({ prompt: 'a cat', model: 'sora-2' });
  });

  test('explicit model that routing does not change keeps bytes', async () => {
    const body = '{"prompt":"a cat","model":"sora-2-pro"}';
    const raw = new Request('http://x/v1/videos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const request = await openAIVideosAdapter.parse(raw, { operation: 'create' });
    const rewritten = await openAIVideosAdapter.rawRequest(raw, request, 'sora-2-pro', new Set(), {
      operation: 'create',
    });
    expect(await rewritten.text()).toBe(body);
  });

  test('missing prompt is 400', async () => {
    const raw = () =>
      new Request('http://x/v1/videos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'sora-2' }),
      });
    await expect(openAIVideosAdapter.parse(raw(), { operation: 'create' })).rejects.toThrow();
    const response = openAIVideosAdapter.errors.requestError(
      await openAIVideosAdapter.parse(raw(), { operation: 'create' }).catch((error: unknown) => error),
    );
    expect(response?.status).toBe(400);
  });
});
