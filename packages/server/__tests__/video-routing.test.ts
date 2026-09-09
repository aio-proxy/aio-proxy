import { describe, expect, test } from 'bun:test';

import { REQUEST_BODY_LIMITS } from '@aio-proxy/core';
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

  test('POST /v1/videos multipart create pins retrieve after a second parse of the spool', async () => {
    const fixture = videoProvider('openai');
    const app = await createServer({ config: { providers: {} }, providerInstances: [fixture.value] });
    const created = await app.request(CREATE, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=VIDEOB' },
      body: ['--VIDEOB\r\nContent-Disposition: form-data; name="prompt"\r\n\r\na cat\r\n', '--VIDEOB--\r\n'].join(''),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ id: 'video_abc', object: 'video', status: 'queued' });
    expect((await app.request('/v1/videos/video_abc')).status).toBe(200);
  });

  test('multipart create still reaches the provider when debug observation wraps the request', async () => {
    const fixture = videoProvider('openai');
    const app = await createServer({
      config: { providers: {}, server: { logging: { level: 'debug' } } },
      providerInstances: [fixture.value],
    });
    const created = await app.request(CREATE, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=VIDEOB' },
      body: ['--VIDEOB\r\nContent-Disposition: form-data; name="prompt"\r\n\r\na cat\r\n', '--VIDEOB--\r\n'].join(''),
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toEqual({ id: 'video_abc', object: 'video', status: 'queued' });
    expect(fixture.calls.raw).toBe(1);
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
    const stolenEdit = await app.request('/v1/videos/edits', {
      method: 'POST',
      headers: { authorization: 'Bearer key-other', 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'warmer light', video: { id: 'video_abc' } }),
    });
    expect(stolenEdit.status).toBe(403);
    expect(await stolenEdit.json()).toMatchObject({ error: { code: 'video_forbidden' } });
    expect(fixture.calls.raw).toBe(before);
  });

  test('remix 2xx pins the new id; pinned edits inject the source model', async () => {
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
    expect(fixture.bodies.at(-1)).toEqual({
      model: 'sora-2',
      prompt: 'warmer light',
      video: { id: 'video_abc' },
    });

    const unpinned = await app.request('/v1/videos/edits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'warmer light', video: { id: 'video_other' } }),
    });
    expect(unpinned.status).toBe(200);
    expect(fixture.bodies.at(-1)).toMatchObject({ model: 'sora-2', prompt: 'warmer light' });

    const extensions = await app.request('/v1/videos/extensions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'two more seconds', video: { id: 'video_abc' } }),
    });
    expect(extensions.status).toBe(200);
    expect(await extensions.json()).toEqual({ id: 'video_extend', object: 'video', status: 'queued' });
    expect((await app.request('/v1/videos/video_extend')).status).toBe(200);
  });

  test('a pinned edit with an explicit model resolves and pins that model', async () => {
    const fixture = videoProvider('openai', { models: ['sora-2', 'sora-2-pro'] });
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
    const afterCreate = fixture.resolves.length;
    const edits = await app.request('/v1/videos/edits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: ' sora-2-pro ', prompt: 'warmer light', video: { id: 'video_abc' } }),
    });
    expect(edits.status).toBe(200);
    expect(fixture.resolves.slice(afterCreate)[0]).toMatchObject({
      protocol: ProviderProtocol.OpenAIVideo,
      modelId: 'sora-2-pro',
    });
    expect(fixture.bodies.at(-1)).toEqual({
      model: 'sora-2-pro',
      prompt: 'warmer light',
      video: { id: 'video_abc' },
    });
    expect((await app.request('/v1/videos/video_edit')).status).toBe(200);
    expect(fixture.resolves.at(-1)).toMatchObject({ modelId: 'sora-2-pro' });
  });

  test('a rewritten pinned edit drops stale body integrity headers', async () => {
    const fixture = videoProvider('openai', { models: ['sora-2', 'sora-2-pro'] });
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
    const edits = await app.request('/v1/videos/edits', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-md5': 'Q2hlY2sgSW50ZWdyaXR5IQ==',
        digest: 'sha-256=deadbeef',
        'content-digest': 'sha-256=:deadbeef:',
      },
      body: JSON.stringify({ model: ' sora-2-pro ', prompt: 'warmer light', video: { id: 'video_abc' } }),
    });
    expect(edits.status).toBe(200);
    const forwarded = fixture.headerBags.at(-1);
    expect(forwarded?.get('content-md5')).toBeNull();
    expect(forwarded?.get('digest')).toBeNull();
    expect(forwarded?.get('content-digest')).toBeNull();
    expect(forwarded?.get('content-type')).toBe('application/json');
  });

  test('a pinned edit without a model keeps the source job model', async () => {
    const fixture = videoProvider('openai', { models: ['sora-2', 'sora-2-pro'] });
    const app = await createServer({ config: { providers: {} }, providerInstances: [fixture.value] });
    expect(
      (
        await app.request(CREATE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: createBody({ model: 'sora-2-pro' }),
        })
      ).status,
    ).toBe(200);
    const afterCreate = fixture.resolves.length;
    const edits = await app.request('/v1/videos/edits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'warmer light', video: { id: 'video_abc' } }),
    });
    expect(edits.status).toBe(200);
    expect(fixture.resolves.slice(afterCreate)[0]).toMatchObject({ modelId: 'sora-2-pro' });
    expect(fixture.bodies.at(-1)).toEqual({
      model: 'sora-2-pro',
      prompt: 'warmer light',
      video: { id: 'video_abc' },
    });
    expect((await app.request('/v1/videos/video_edit')).status).toBe(200);
    expect(fixture.resolves.at(-1)).toMatchObject({ modelId: 'sora-2-pro' });
  });

  test('an unpinned edit 404 fails over to the next video provider', async () => {
    const missing = videoProvider('missing', { notFoundOnEdits: true });
    const owner = videoProvider('owner');
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [missing.value, owner.value],
    });
    const edits = await app.request('/v1/videos/edits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'warmer light', video: { id: 'video_other' } }),
    });
    expect(edits.status).toBe(200);
    expect(await edits.json()).toEqual({ id: 'video_edit', object: 'video', status: 'queued' });
    expect(missing.calls.raw).toBe(1);
    expect(owner.calls.raw).toBe(1);
    expect((await app.request('/v1/videos/video_edit')).status).toBe(200);
  });

  test('a create 404 does not fail over to the next video provider', async () => {
    const missing = videoProvider('missing', { notFoundOnCreate: true });
    const owner = videoProvider('owner');
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [missing.value, owner.value],
    });
    const created = await app.request(CREATE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: createBody(),
    });
    expect(created.status).toBe(404);
    expect(missing.calls.raw).toBe(1);
    expect(owner.calls.raw).toBe(0);
  });

  test('a pinned edit whose explicit model the provider cannot resolve is 503', async () => {
    const pinned = videoProvider('openai', {
      models: ['sora-2', 'sora-2-pro'],
      rejectModelIds: ['sora-2-pro'],
    });
    const other = videoProvider('backup', { models: ['sora-2-pro'] });
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [pinned.value, other.value],
    });
    expect(
      (
        await app.request(CREATE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: createBody(),
        })
      ).status,
    ).toBe(200);
    expect(pinned.calls.raw).toBe(1);
    const edits = await app.request('/v1/videos/edits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sora-2-pro', prompt: 'warmer light', video: { id: 'video_abc' } }),
    });
    expect(edits.status).toBe(503);
    expect(await edits.json()).toMatchObject({ error: { code: 'video_upstream_unavailable' } });
    expect(other.calls.raw).toBe(0);
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

  test('an illegal edits video.id is 400 and does not enter the pipeline', async () => {
    const fixture = videoProvider('openai');
    const response = await request(
      '/v1/videos/edits',
      [fixture.value],
      JSON.stringify({
        prompt: 'warmer light',
        video: { id: 'not.valid' },
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(fixture.calls.raw).toBe(0);
  });

  test('a pinned edit with a blank prompt is 400 without upstream fetch', async () => {
    const fixture = videoProvider('openai');
    const app = await createServer({ config: { providers: {} }, providerInstances: [fixture.value] });
    await app.request(CREATE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: createBody(),
    });
    const before = fixture.calls.raw;
    const blank = await app.request('/v1/videos/edits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '  ', video: { id: 'video_abc' } }),
    });
    expect(blank.status).toBe(400);
    expect(fixture.calls.raw).toBe(before);
  });

  test('remix pin checks run before store capacity', async () => {
    const fixture = videoProvider('openai');
    const app = await createServer({ config: { providers: {} }, providerInstances: [fixture.value] });
    const illegal = await app.request('/v1/videos/not.valid/remix', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'warmer light' }),
    });
    expect(illegal.status).toBe(400);
    const missing = await app.request('/v1/videos/video_missing/remix', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'warmer light' }),
    });
    expect(missing.status).toBe(404);
    expect(fixture.calls.raw).toBe(0);
  });

  test('remix rejects a missing prompt and an oversized body before the pinned invoke', async () => {
    const fixture = videoProvider('openai');
    const app = await createServer({ config: { providers: {} }, providerInstances: [fixture.value] });
    await app.request(CREATE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: createBody(),
    });
    const before = fixture.calls.raw;
    const missing = await app.request('/v1/videos/video_abc/remix', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missing.status).toBe(400);
    const oversized = await app.request('/v1/videos/video_abc/remix', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(REQUEST_BODY_LIMITS.encoded + 1),
      },
      body: JSON.stringify({ prompt: 'warmer light' }),
    });
    expect(oversized.status).toBe(413);
    expect(fixture.calls.raw).toBe(before);
  });

  test('multipart edits is 415 and never pin-firsts', async () => {
    const fixture = videoProvider('openai');
    const app = await createServer({ config: { providers: {} }, providerInstances: [fixture.value] });
    await app.request(CREATE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: createBody(),
    });
    const before = fixture.calls.raw;
    const form = new FormData();
    form.set('prompt', 'warmer light');
    form.set('video', JSON.stringify({ id: 'video_abc' }));
    const multipart = await app.request('/v1/videos/edits', { method: 'POST', body: form });
    expect(multipart.status).toBe(415);
    expect(await multipart.json()).toMatchObject({ error: { code: 'invalid_request' } });
    expect(fixture.calls.raw).toBe(before);
  });

  test('an oversized edits peek is 413 before store lookup', async () => {
    const fixture = videoProvider('openai');
    const app = await createServer({ config: { providers: {} }, providerInstances: [fixture.value] });
    await app.request(CREATE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: createBody(),
    });
    const before = fixture.calls.raw;
    const oversized = await app.request('/v1/videos/edits', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(REQUEST_BODY_LIMITS.encoded + 1),
      },
      body: JSON.stringify({ prompt: 'warmer light', video: { id: 'video_abc' } }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ error: { code: 'request_too_large' } });
    expect(fixture.calls.raw).toBe(before);
  });

  test('an unsupported follow-up Content-Encoding is 415 before store lookup', async () => {
    const fixture = videoProvider('openai');
    const app = await createServer({ config: { providers: {} }, providerInstances: [fixture.value] });
    const encoded = await app.request('/v1/videos/edits', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-encoding': 'compress',
      },
      body: JSON.stringify({ prompt: 'warmer light', video: { id: 'video_abc' } }),
    });
    expect(encoded.status).toBe(415);
    expect(await encoded.json()).toEqual({
      error: {
        code: 'unsupported_content_encoding',
        message: 'Unsupported Content-Encoding',
        type: 'invalid_request_error',
      },
    });
    expect(fixture.calls.raw).toBe(0);
  });

  test('a missing pinned raw is 503 and does not walk other video candidates', async () => {
    const pinned = videoProvider('openai');
    const other = videoProvider('backup');
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [pinned.value, other.value],
    });
    expect(
      (
        await app.request(CREATE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: createBody(),
        })
      ).status,
    ).toBe(200);
    const createdBy = pinned.calls.raw === 1 ? pinned : other;
    const unused = createdBy === pinned ? other : pinned;
    createdBy.disableRaw();
    const beforeUnused = unused.calls.raw;
    const retrieved = await app.request('/v1/videos/video_abc');
    expect(retrieved.status).toBe(503);
    expect(await retrieved.json()).toMatchObject({ error: { code: 'video_upstream_unavailable' } });
    expect(unused.calls.raw).toBe(beforeUnused);
  });

  test('pinned follow-ups resolve raw with the inbound request path', async () => {
    const fixture = videoProvider('openai', { requireRequestPath: true });
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
    const retrieved = await app.request('/v1/videos/video_abc');
    expect(retrieved.status).toBe(200);
    expect(fixture.resolves.some((input) => input.requestPath === '/v1/videos/video_abc')).toBe(true);
  });

  test('a throwing unpinned create cancels the credential-sanitized body', async () => {
    const fixture = videoProvider('openai', { throwOnInvoke: true });
    const app = await createServer({ config: { providers: {} }, providerInstances: [fixture.value] });
    const created = await app.request(CREATE, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer caller-secret-credential',
      },
      body: createBody({ model: 'sora-2' }),
    });
    expect(created.status).toBeGreaterThanOrEqual(500);
    expect(fixture.invoked.at(-1)?.bodyUsed).toBe(true);
  });

  test('a keyless unpinned create does not forward caller credentials', async () => {
    const fixture = videoProvider('openai');
    const app = await createServer({ config: { providers: {} }, providerInstances: [fixture.value] });
    const sentinel = 'caller-secret-credential';
    const created = await app.request(`/v1/videos?key=${sentinel}&auth_token=${sentinel}&variant=thumbnail`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sentinel}`,
        'x-api-key': sentinel,
        'x-goog-api-key': sentinel,
      },
      body: createBody({ model: 'sora-2' }),
    });
    expect(created.status).toBe(200);
    const forwarded = fixture.headerBags.at(-1);
    expect(forwarded?.get('authorization')).toBeNull();
    expect(forwarded?.get('x-api-key')).toBeNull();
    expect(forwarded?.get('x-goog-api-key')).toBeNull();
    expect([...(forwarded?.values() ?? [])].join('\n')).not.toContain(sentinel);
    expect(fixture.urls.at(-1)).not.toContain(sentinel);
    expect(fixture.urls.at(-1)).toContain('variant=thumbnail');
  });

  test('a keyless unpinned edit does not forward caller credentials', async () => {
    const fixture = videoProvider('openai');
    const app = await createServer({ config: { providers: {} }, providerInstances: [fixture.value] });
    const sentinel = 'caller-secret-credential';
    const edits = await app.request(`/v1/videos/edits?key=${sentinel}&auth_token=${sentinel}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sentinel}`,
        'x-api-key': sentinel,
        'x-goog-api-key': sentinel,
      },
      body: JSON.stringify({ model: 'sora-2', prompt: 'warmer light', video: { id: 'video_unknown' } }),
    });
    expect(edits.status).toBe(200);
    const forwarded = fixture.headerBags.at(-1);
    expect(forwarded?.get('authorization')).toBeNull();
    expect(forwarded?.get('x-api-key')).toBeNull();
    expect(forwarded?.get('x-goog-api-key')).toBeNull();
    expect([...(forwarded?.values() ?? [])].join('\n')).not.toContain(sentinel);
    expect(fixture.urls.at(-1)).not.toContain(sentinel);
  });

  test('a keyless pinned follow-up does not forward caller credentials', async () => {
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
    const sentinel = 'caller-secret-credential';
    const retrieved = await app.request('/v1/videos/video_abc', {
      headers: {
        authorization: `Bearer ${sentinel}`,
        'x-api-key': sentinel,
        'x-goog-api-key': sentinel,
      },
    });
    expect(retrieved.status).toBe(200);
    const forwarded = fixture.headerBags.at(-1);
    expect(forwarded?.get('authorization')).toBeNull();
    expect(forwarded?.get('x-api-key')).toBeNull();
    expect(forwarded?.get('x-goog-api-key')).toBeNull();
    expect([...(forwarded?.values() ?? [])].join('\n')).not.toContain(sentinel);
  });

  test('content forwards the inbound variant query to the pinned provider', async () => {
    const fixture = videoProvider('openai');
    const app = await createServer({ config: { providers: {} }, providerInstances: [fixture.value] });
    await app.request(CREATE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: createBody(),
    });
    const content = await app.request('/v1/videos/video_abc/content?variant=thumbnail');
    expect(content.status).toBe(200);
    expect(fixture.urls.at(-1)).toContain('variant=thumbnail');
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
    readonly models?: readonly string[];
    readonly raw?: false;
    readonly rejectModelIds?: readonly string[];
    readonly requireRequestPath?: boolean;
    readonly notFoundOnCreate?: boolean;
    readonly notFoundOnEdits?: boolean;
    readonly speech?: boolean;
    readonly throwOnInvoke?: boolean;
  } = {},
): {
  readonly bodies: unknown[];
  readonly calls: VideoCalls;
  readonly disableRaw: () => void;
  readonly headerBags: Headers[];
  readonly invoked: Request[];
  readonly resolves: RawResolveInput[];
  readonly urls: string[];
  readonly value: RuntimeProviderInstance;
} {
  const calls: VideoCalls = { model: 0, raw: 0, speech: 0 };
  const resolves: RawResolveInput[] = [];
  const bodies: unknown[] = [];
  const headerBags: Headers[] = [];
  const invoked: Request[] = [];
  const urls: string[] = [];
  const modelIds = options.models ?? ['sora-2'];
  const rejectModelIds = [...(options.rejectModelIds ?? [])];
  let rawAvailable = options.raw !== false;
  const granted = new Set(options.capabilities ?? (['video'] as const));
  return {
    bodies,
    calls,
    disableRaw() {
      rawAvailable = false;
    },
    headerBags,
    invoked,
    resolves,
    urls,
    value: {
      capabilityIndex: Object.fromEntries(modelIds.map((modelId) => [modelId, granted])),
      enabled: true,
      id,
      kind: ProviderKind.Api,
      models: [...modelIds],
      model: { invoke: () => ((calls.model += 1), new ReadableStream()) },
      raw:
        options.raw === false
          ? undefined
          : {
              resolve: (input: RawResolveInput) => {
                resolves.push(input);
                if (!rawAvailable || input.protocol !== ProviderProtocol.OpenAIVideo) return undefined;
                if (options.requireRequestPath === true && input.requestPath === undefined) return undefined;
                if (rejectModelIds.includes(input.modelId)) return undefined;
                return {
                  invoke: async (request: Request) => {
                    calls.raw += 1;
                    invoked.push(request);
                    headerBags.push(new Headers(request.headers));
                    urls.push(request.url);
                    if (options.throwOnInvoke === true) throw new Error('upstream down');
                    const path = new URL(request.url).pathname;
                    try {
                      bodies.push(await request.clone().json());
                    } catch {
                      bodies.push(undefined);
                    }
                    if (options.notFoundOnCreate === true && /\/v1\/videos$/u.test(path)) {
                      return Response.json({ error: { code: 'not_found' } }, { status: 404 });
                    }
                    if (options.notFoundOnEdits === true && path.includes('/edits')) {
                      return Response.json({ error: { code: 'not_found' } }, { status: 404 });
                    }
                    const videoId = path.endsWith('/remix')
                      ? 'video_remix'
                      : path.includes('/edits')
                        ? 'video_edit'
                        : path.includes('/extensions')
                          ? 'video_extend'
                          : 'video_abc';
                    return Response.json({ id: videoId, object: 'video', status: 'queued' });
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
