import { expect, test } from 'bun:test';

import { ProviderKind } from '@aio-proxy/types';

import { ANONYMOUS_CALLER } from '../../caller-principal';
import type { RuntimeProviderInstance } from '../../runtime';
import { createVideoJobStore } from './job-store';
import { pinSuccessfulVideoJob, VIDEO_JOB_JSON_LIMIT } from './pin';
import type { VideosRouteSource } from './source';

test('a small official job JSON pins the id', async () => {
  const videoJobs = createVideoJobStore();
  const source = pinSource(videoJobs);
  const response = Response.json({ id: 'video_abc', object: 'video', status: 'queued' });
  await pinSuccessfulVideoJob(source, ANONYMOUS_CALLER, {
    provider: pinProvider(),
    modelId: 'sora-2',
    response,
  });
  expect(videoJobs.lookup('video_abc')?.providerId).toBe('openai');
  expect(await response.json()).toMatchObject({ id: 'video_abc' });
});

test('an oversized job JSON is a failed pin and leaves the client body readable', async () => {
  const videoJobs = createVideoJobStore();
  const logs: unknown[] = [];
  const source = pinSource(videoJobs, (entry) => logs.push(entry));
  const response = new Response(
    `${JSON.stringify({ id: 'video_abc', object: 'video', status: 'queued' })}${' '.repeat(VIDEO_JOB_JSON_LIMIT)}`,
    { headers: { 'content-type': 'application/json' } },
  );
  await pinSuccessfulVideoJob(source, ANONYMOUS_CALLER, {
    provider: pinProvider(),
    modelId: 'sora-2',
    response,
  });
  expect(videoJobs.lookup('video_abc')).toBeUndefined();
  expect(logs).toContainEqual(expect.objectContaining({ event: 'video.job_pin_failed', providerId: 'openai' }));
  expect(await response.json()).toMatchObject({ id: 'video_abc' });
});

function pinSource(
  videoJobs: ReturnType<typeof createVideoJobStore>,
  logger: VideosRouteSource['logger'] = () => {},
): VideosRouteSource {
  return { videoJobs, logger } as VideosRouteSource;
}

function pinProvider(): RuntimeProviderInstance {
  return { id: 'openai', enabled: true, kind: ProviderKind.Api } as RuntimeProviderInstance;
}
