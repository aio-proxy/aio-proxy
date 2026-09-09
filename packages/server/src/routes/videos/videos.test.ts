import { describe, expect, test } from 'bun:test';

import { defineProviderRouteSource } from '../../../__tests__/pipeline-helpers';
import { ANONYMOUS_CALLER } from '../../caller-principal';
import { createVideoJobStore } from './job-store';
import { createOpenAIVideosRoutes } from './videos';

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
});

function videosApp(capacity: number) {
  const route = defineProviderRouteSource([]);
  return createOpenAIVideosRoutes({
    ...route.source,
    videoJobs: createVideoJobStore({ capacity }),
  });
}
