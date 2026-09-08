import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { releaseMultipartSpool } from '../../ingress/openai-video';
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

  test('rebuilds rather than replays when the client sent repeated model fields', async () => {
    const raw = videoMultipart([
      ['model', 'sora-2'],
      ['model', 'sora-2-pro'],
      ['prompt', 'a cat'],
    ]);
    const request = await openAIVideosAdapter.parse(raw, { operation: 'create' });
    expect(request.model).toBe('sora-2-pro');
    const rewritten = await openAIVideosAdapter.rawRequest(raw, request, 'sora-2-pro', new Set(), {
      operation: 'create',
    });
    const form = await rewritten.formData();
    expect(form.getAll('model')).toEqual(['sora-2-pro']);
    await releaseMultipartSpool(raw);
  });

  test.each([
    [undefined, [['model[]', 'sora-2-pro']]],
    ['sora-2-pro', [['model[]', 'sora-2-pro']]],
  ] as const)('rebuilds rather than replays when the model is spelled %p / %p', async (model, extra) => {
    const raw = videoMultipart([
      ...(model === undefined ? [] : [['model', model] as const]),
      ...extra,
      ['prompt', 'a cat'],
    ]);
    const request = await openAIVideosAdapter.parse(raw, { operation: 'create' });
    const rewritten = await openAIVideosAdapter.rawRequest(raw, request, 'sora-2-pro', new Set(), {
      operation: 'create',
    });
    const form = await rewritten.formData();
    expect(form.getAll('model')).toEqual(['sora-2-pro']);
    expect(form.getAll('model[]')).toEqual([]);
    await releaseMultipartSpool(raw);
  });

  test('multipart omitted model injects sora-2 on rewrite', async () => {
    const form = new FormData();
    form.set('prompt', 'a cat');
    const raw = new Request('http://x/v1/videos', { method: 'POST', body: form });
    const request = await openAIVideosAdapter.parse(raw, { operation: 'create' });
    const rewritten = await openAIVideosAdapter.rawRequest(raw, request, 'sora-2', new Set(), { operation: 'create' });
    const forwarded = await rewritten.formData();
    expect(forwarded.get('prompt')).toBe('a cat');
    expect(forwarded.get('model')).toBe('sora-2');
    await releaseMultipartSpool(raw);
  });

  test('malformed multipart is 400, not an unmapped 500', async () => {
    const raw = new Request('http://x/v1/videos', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=----boundary' },
      body: 'not-a-multipart-body',
    });
    const error = await openAIVideosAdapter.parse(raw, { operation: 'create' }).catch((caught: unknown) => caught);
    const response = openAIVideosAdapter.errors.requestError(error);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });
});

function videoMultipart(fields: readonly (readonly [string, string])[]): Request {
  const boundary = 'VIDEOB';
  const text = `${fields
    .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    .join('')}--${boundary}--\r\n`;
  return new Request('http://x/v1/videos', {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: new TextEncoder().encode(text),
  });
}
