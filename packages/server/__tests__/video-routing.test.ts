import { describe, expect, test } from 'bun:test';

import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { createServer } from '#server-test-lifecycle';

import type { InboundCapability, RawResolveInput, RuntimeProviderInstance } from '../src/runtime';

const CREATE = '/v1/videos';

function createBody(body: Record<string, unknown> = {}): string {
  return JSON.stringify({ prompt: 'a cat', ...body });
}

describe('OpenAI Videos HTTP dispatch', () => {
  test('POST /v1/videos raw-passthroughs and pins retrieve to the creating provider', async () => {
    const fixture = videoProvider('openai');
    const app = await createServer({ config: { providers: {} }, providerInstances: [fixture.value] });
    const created = await app.request(CREATE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: createBody(),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ id: 'video_abc', object: 'video', status: 'queued' });
    expect(fixture.calls.raw).toBe(1);
    expect(fixture.calls.model).toBe(0);

    const retrieved = await app.request('/v1/videos/video_abc');
    expect(retrieved.status).toBe(200);
    expect(await retrieved.json()).toEqual({ id: 'video_abc', object: 'video', status: 'queued' });
    expect(fixture.calls.raw).toBe(2);
    expect(fixture.resolves[0]).toMatchObject({
      protocol: ProviderProtocol.OpenAIVideo,
      modelId: 'sora-2',
    });
  });

  test('a raw-less video provider is 501 video_convert, not a speech invoke', async () => {
    const fixture = videoProvider('sdk', { raw: false, speech: true });
    const response = await request(CREATE, [fixture.value], createBody());
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      error: {
        code: 'unsupported_feature',
        message: 'OpenAI Videos feature is not supported: video_convert',
        type: 'invalid_request_error',
      },
    });
    expect(fixture.calls).toEqual({ model: 0, raw: 0, speech: 0 });
  });

  test('GET /v1/videos and character ports are 501; /v1/videos/generations is 404', async () => {
    const app = await createServer({ config: { providers: {} } });
    const list = await app.request('/v1/videos');
    expect(list.status).toBe(501);
    expect(await list.json()).toMatchObject({ error: { code: 'video_capability_not_supported' } });
    expect((await app.request('/v1/videos/characters', { method: 'POST' })).status).toBe(501);
    expect((await app.request('/v1/videos/characters/char_1')).status).toBe(501);
    expect((await app.request('/v1/videos/generations', { method: 'POST' })).status).toBe(404);
  });

  test('missing pin is 404, an illegal id is 400, and a stolen id is 403 without upstream fetch', async () => {
    const fixture = videoProvider('openai');
    const app = await createServer({
      config: { providers: {}, server: { apiKeys: [{ key: 'key-owner' }, { key: 'key-other' }] } },
      providerInstances: [fixture.value],
    });
    expect(
      (await app.request('/v1/videos/video_missing', { headers: { authorization: 'Bearer key-owner' } })).status,
    ).toBe(404);
    const created = await app.request(CREATE, {
      method: 'POST',
      headers: { authorization: 'Bearer key-owner', 'content-type': 'application/json' },
      body: createBody(),
    });
    expect(created.status).toBe(200);
    const before = fixture.calls.raw;
    expect(
      (
        await app.request('/v1/videos/not.valid', {
          headers: { authorization: 'Bearer key-owner' },
        })
      ).status,
    ).toBe(400);
    const stolen = await app.request('/v1/videos/video_abc', { headers: { authorization: 'Bearer key-other' } });
    expect(stolen.status).toBe(403);
    expect(await stolen.json()).toMatchObject({ error: { code: 'video_forbidden' } });
    expect(fixture.calls.raw).toBe(before);
  });

  test('remix 2xx pins the new id; edits with a pin skip model rewrite', async () => {
    const fixture = videoProvider('openai');
    const app = await createServer({ config: { providers: {} }, providerInstances: [fixture.value] });
    expect(
      (
        await app.request(CREATE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: createBody(),
        })
      ).status,
    ).toBe(200);

    const remix = await app.request('/v1/videos/video_abc/remix', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'warmer light' }),
    });
    expect(remix.status).toBe(200);
    expect(await remix.json()).toEqual({ id: 'video_remix', object: 'video', status: 'queued' });
    expect((await app.request('/v1/videos/video_remix')).status).toBe(200);

    const edits = await app.request('/v1/videos/edits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'warmer light', video: { id: 'video_abc' } }),
    });
    expect(edits.status).toBe(200);
    expect(fixture.bodies.at(-1)).toEqual({ prompt: 'warmer light', video: { id: 'video_abc' } });

    const unpinned = await app.request('/v1/videos/edits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'warmer light', video: { id: 'video_other' } }),
    });
    expect(unpinned.status).toBe(200);
    expect(fixture.bodies.at(-1)).toMatchObject({ model: 'sora-2', prompt: 'warmer light' });
  });

  test('a language-only catalog cannot serve Videos', async () => {
    const fixture = videoProvider('chat', { capabilities: ['language'] });
    const response = await request(CREATE, [fixture.value], createBody({ model: 'sora-2' }));
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual({
      error: {
        code: 'not_implemented',
        message: 'No configured provider can generate videos for this model',
        type: 'invalid_request_error',
      },
    });
    expect(fixture.calls.raw).toBe(0);
  });

  test('a speech transport never grants Videos', async () => {
    const fixture = videoProvider('tts', { capabilities: ['speech'], raw: false, speech: true });
    const response = await request(CREATE, [fixture.value], createBody({ model: 'sora-2' }));
    expect(response.status).toBe(501);
    expect(fixture.calls).toEqual({ model: 0, raw: 0, speech: 0 });
  });

  test('delete on 2xx drops the pin', async () => {
    const fixture = videoProvider('openai');
    const app = await createServer({ config: { providers: {} }, providerInstances: [fixture.value] });
    await app.request(CREATE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: createBody(),
    });
    expect((await app.request('/v1/videos/video_abc', { method: 'DELETE' })).status).toBe(200);
    expect((await app.request('/v1/videos/video_abc')).status).toBe(404);
  });
});

type VideoCalls = { model: number; raw: number; speech: number };

function videoProvider(
  id: string,
  options: {
    readonly capabilities?: readonly InboundCapability[];
    readonly raw?: false;
    readonly speech?: boolean;
  } = {},
): {
  readonly bodies: unknown[];
  readonly calls: VideoCalls;
  readonly resolves: RawResolveInput[];
  readonly value: RuntimeProviderInstance;
} {
  const calls: VideoCalls = { model: 0, raw: 0, speech: 0 };
  const resolves: RawResolveInput[] = [];
  const bodies: unknown[] = [];
  const granted = new Set(options.capabilities ?? (['video'] as const));
  return {
    bodies,
    calls,
    resolves,
    value: {
      capabilityIndex: { 'sora-2': granted },
      enabled: true,
      id,
      kind: ProviderKind.Api,
      models: ['sora-2'],
      model: { invoke: () => ((calls.model += 1), new ReadableStream()) },
      raw:
        options.raw === false
          ? undefined
          : {
              resolve: (input: RawResolveInput) => {
                resolves.push(input);
                if (input.protocol !== ProviderProtocol.OpenAIVideo) return undefined;
                return {
                  invoke: async (request: Request) => {
                    calls.raw += 1;
                    const path = new URL(request.url).pathname;
                    try {
                      bodies.push(await request.clone().json());
                    } catch {
                      bodies.push(undefined);
                    }
                    const id = path.endsWith('/remix')
                      ? 'video_remix'
                      : path.includes('/edits')
                        ? 'video_edit'
                        : 'video_abc';
                    return Response.json({ id, object: 'video', status: 'queued' });
                  },
                };
              },
            },
      speech:
        options.speech === true
          ? {
              invoke: async () => {
                calls.speech += 1;
                return { audio: new Uint8Array([1]), mediaType: 'audio/mpeg' };
              },
            }
          : undefined,
    } satisfies RuntimeProviderInstance,
  };
}

async function request(path: string, providers: readonly RuntimeProviderInstance[], body: string) {
  const app = await createServer({ config: { providers: {} }, providerInstances: providers });
  return app.request(path, { body, headers: { 'content-type': 'application/json' }, method: 'POST' });
}
