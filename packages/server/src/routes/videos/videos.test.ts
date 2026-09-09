import { describe, expect, test } from 'bun:test';

import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { defineProviderRouteSource } from '../../../__tests__/pipeline-helpers';
import { ANONYMOUS_CALLER } from '../../caller-principal';
import { createVideoJobStore } from './job-store';
import { createOpenAIVideosRoutes } from './videos';

describe('OpenAI Videos create capacity', () => {
  test('a malformed or incomplete create is not 503 when the job store is full', async () => {
    const app = videosApp(0);
    const cases: ReadonlyArray<{ readonly init: RequestInit; readonly status: number; readonly code: string }> = [
      {
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' },
        status: 400,
        code: 'invalid_request',
      },
      {
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
        status: 400,
        code: 'invalid_request',
      },
      {
        init: { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'a cat' },
        status: 415,
        code: 'invalid_request',
      },
      {
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-encoding': 'compress' },
          body: '{}',
        },
        status: 415,
        code: 'unsupported_content_encoding',
      },
      {
        init: { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '999999999' } },
        status: 413,
        code: 'request_too_large',
      },
    ];
    for (const { init, status, code } of cases) {
      const response = await app.request('/v1/videos', init);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ error: { code } });
    }
  });

  test('a multipart create without a prompt is 400 when the job store is full', async () => {
    const response = await videosApp(0).request('/v1/videos', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=VIDEOB' },
      body: '--VIDEOB\r\nContent-Disposition: form-data; name="model"\r\n\r\nsora-2\r\n--VIDEOB--\r\n',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
  });

  test('a valid create is 503 when the job store is full', async () => {
    const response = await videosApp(0).request('/v1/videos', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'a cat' }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'video_store_full' } });
  });
});

describe('OpenAI Videos follow-up capacity', () => {
  test('a missing or non-string edits video.id is 400 when the job store is full', async () => {
    const app = videosApp(0);
    for (const body of [
      { prompt: 'warmer light' },
      { prompt: 'warmer light', video: 1 },
      { prompt: 'warmer light', video: { id: 1 } },
    ]) {
      const response = await app.request('/v1/videos/edits', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } });
    }
  });

  test('a valid unpinned edit is 503 when the job store is full', async () => {
    const app = videosApp(0);
    const response = await app.request('/v1/videos/edits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'warmer light', video: { id: 'video_abc' } }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'video_store_full' } });
  });

  test('an early follow-up reject releases the inbound body', async () => {
    const app = videosApp(1);
    const request = new Request('http://proxy.test/v1/videos/edits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'warmer light' }),
    });
    const response = await app.request(request);
    expect(response.status).toBe(400);
    expect(request.bodyUsed).toBe(true);
  });

  test('an unavailable pinned provider releases the inbound body', async () => {
    const videoJobs = createVideoJobStore({ capacity: 2 });
    videoJobs.insert({
      videoId: 'video_abc',
      providerId: 'openai',
      model: 'sora-2',
      owner: ANONYMOUS_CALLER,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });
    const route = defineProviderRouteSource([]);
    const app = createOpenAIVideosRoutes({ ...route.source, videoJobs });
    const request = new Request('http://proxy.test/v1/videos/edits', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'sora-2', prompt: 'warmer light', video: { id: 'video_abc' } }),
    });
    const response = await app.request(request);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'video_upstream_unavailable' } });
    expect(request.bodyUsed).toBe(true);
  });

  test('a throwing pinned invoke cancels the credential-sanitized body', async () => {
    const videoJobs = createVideoJobStore({ capacity: 2 });
    videoJobs.insert({
      videoId: 'video_abc',
      providerId: 'openai',
      model: 'sora-2',
      owner: ANONYMOUS_CALLER,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });
    let forwarded: Request | undefined;
    const route = defineProviderRouteSource([
      {
        calls: { ensure: 0, model: [], raw: [] },
        provider: {
          capabilityIndex: { 'sora-2': new Set(['video']) },
          enabled: true,
          id: 'openai',
          kind: ProviderKind.Api,
          models: ['sora-2'],
          raw: {
            resolve: ({ protocol }) =>
              protocol === ProviderProtocol.OpenAIVideo
                ? {
                    invoke: async (request) => {
                      forwarded = request;
                      throw new Error('upstream down');
                    },
                  }
                : undefined,
          },
        },
      },
    ]);
    const app = createOpenAIVideosRoutes({ ...route.source, videoJobs });
    const request = new Request('http://proxy.test/v1/videos/edits', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer caller-secret-credential',
      },
      body: JSON.stringify({ model: 'sora-2', prompt: 'warmer light', video: { id: 'video_abc' } }),
    });
    const response = await app.request(request);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'video_upstream_unavailable' } });
    expect(forwarded).toBeDefined();
    expect(forwarded).not.toBe(request);
    expect(forwarded?.bodyUsed).toBe(true);
  });

  test('an aborted pinned invoke cancels the credential-sanitized body', async () => {
    const videoJobs = createVideoJobStore({ capacity: 2 });
    videoJobs.insert({
      videoId: 'video_abc',
      providerId: 'openai',
      model: 'sora-2',
      owner: ANONYMOUS_CALLER,
      createdAt: 1,
      expiresAt: Date.now() + 60_000,
    });
    let forwarded: Request | undefined;
    const controller = new AbortController();
    const route = defineProviderRouteSource([
      {
        calls: { ensure: 0, model: [], raw: [] },
        provider: {
          capabilityIndex: { 'sora-2': new Set(['video']) },
          enabled: true,
          id: 'openai',
          kind: ProviderKind.Api,
          models: ['sora-2'],
          raw: {
            resolve: ({ protocol }) =>
              protocol === ProviderProtocol.OpenAIVideo
                ? {
                    invoke: async (request) => {
                      forwarded = request;
                      controller.abort();
                      throw new DOMException('The operation was aborted', 'AbortError');
                    },
                  }
                : undefined,
          },
        },
      },
    ]);
    const app = createOpenAIVideosRoutes({ ...route.source, videoJobs });
    const request = new Request('http://proxy.test/v1/videos/edits', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer caller-secret-credential',
      },
      body: JSON.stringify({ model: 'sora-2', prompt: 'warmer light', video: { id: 'video_abc' } }),
      signal: controller.signal,
    });
    const response = await app.request(request);
    expect(response.status).toBe(499);
    expect(forwarded).toBeDefined();
    expect(forwarded).not.toBe(request);
    expect(forwarded?.bodyUsed).toBe(true);
  });
});

function videosApp(capacity: number) {
  const route = defineProviderRouteSource([]);
  return createOpenAIVideosRoutes({
    ...route.source,
    videoJobs: createVideoJobStore({ capacity }),
  });
}
