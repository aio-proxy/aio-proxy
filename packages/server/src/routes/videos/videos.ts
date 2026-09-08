import { openAIVideosAdapter, readJsonRequest, REQUEST_BODY_LIMITS, RequestBodyTooLargeError } from '@aio-proxy/core';
import { type Context, Hono } from 'hono';

import { callerPrincipal, type CallerPrincipalEnv } from '../../caller-principal';
import { handleProtocolRequest, hasInvalidOrOversizedContentLength } from '../pipeline';
import { videoCapabilityNotSupported, videoForbidden, videoStoreFull } from './errors';
import { isValidVideoId, sameVideoOwner } from './job-store';
import { pinSuccessfulVideoJob } from './pin';
import { handlePinnedVideoRequest, invokePinnedVideo, sourceVideoIdFromBody } from './pinned';
import type { VideosRouteSource } from './source';

export const UNSUPPORTED_VIDEO_ROUTES = [
  { method: 'get', path: '/v1/videos' },
  { method: 'post', path: '/v1/videos/characters' },
  { method: 'get', path: '/v1/videos/characters/:character_id' },
] as const;

export function createOpenAIVideosRoutes(source: VideosRouteSource) {
  const app = new Hono<CallerPrincipalEnv>();

  for (const route of UNSUPPORTED_VIDEO_ROUTES) {
    app[route.method](route.path, () => videoCapabilityNotSupported());
  }

  app.post('/v1/videos/edits', (context) => handleFollowUpCreate(context, source, 'edits'));
  app.post('/v1/videos/extensions', (context) => handleFollowUpCreate(context, source, 'extensions'));
  app.post('/v1/videos', (context) => handleVideoCreate(context, source));

  app.post('/v1/videos/:video_id/remix', (context) =>
    withCapacity(source, () => handlePinnedVideoRequest(context, source, { pinNewJob: true })),
  );
  app.get('/v1/videos/:video_id/content', (context) => handlePinnedVideoRequest(context, source));
  app.get('/v1/videos/:video_id', (context) => handlePinnedVideoRequest(context, source));
  app.delete('/v1/videos/:video_id', (context) => handlePinnedVideoRequest(context, source));

  return app;
}

async function handleVideoCreate(context: Context<CallerPrincipalEnv>, source: VideosRouteSource) {
  return await withCapacity(source, () =>
    handleProtocolRequest({
      adapter: openAIVideosAdapter,
      context: { operation: 'create' },
      rawRequest: context.req.raw,
      source,
      onSuccessfulAttempt: (info) => pinSuccessfulVideoJob(source, callerPrincipal(context), info),
    }),
  );
}

async function handleFollowUpCreate(
  context: Context<CallerPrincipalEnv>,
  source: VideosRouteSource,
  operation: 'edits' | 'extensions',
) {
  const owner = callerPrincipal(context);
  const sourceId = await peekFollowUpSourceVideoId(context.req.raw);
  if (sourceId instanceof Response) return sourceId;
  if (isValidVideoId(sourceId)) {
    const record = source.videoJobs.lookup(sourceId);
    if (record !== undefined && !sameVideoOwner(record.owner, owner)) return videoForbidden();
    if (record !== undefined) {
      return await withCapacity(source, () => invokePinnedVideo(context, source, record, { pinNewJob: true }));
    }
  }
  return await withCapacity(source, () =>
    handleProtocolRequest({
      adapter: openAIVideosAdapter,
      context: { operation },
      rawRequest: context.req.raw,
      source,
      onSuccessfulAttempt: (info) => pinSuccessfulVideoJob(source, owner, info),
    }),
  );
}

async function withCapacity(source: VideosRouteSource, run: () => Promise<Response>): Promise<Response> {
  const slot = source.videoJobs.reserveCapacity();
  if (slot === undefined) return videoStoreFull();
  try {
    return await run();
  } finally {
    slot.release();
  }
}

async function peekFollowUpSourceVideoId(raw: Request): Promise<string | undefined | Response> {
  if (hasInvalidOrOversizedContentLength(raw, REQUEST_BODY_LIMITS)) {
    return openAIVideosAdapter.errors.tooLarge();
  }
  try {
    return sourceVideoIdFromBody(await readJsonRequest(raw.clone(), REQUEST_BODY_LIMITS));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) return openAIVideosAdapter.errors.tooLarge();
    return undefined;
  }
}
