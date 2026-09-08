import {
  isJsonRequest,
  isMultipartRequest,
  openAIVideosAdapter,
  OpenAIVideosInvalidRequestError,
  parseOpenAIVideoEdit,
  parseOpenAIVideoRemix,
  readJsonRequest,
  REQUEST_BODY_LIMITS,
  RequestBodyTooLargeError,
} from '@aio-proxy/core';
import { type Context, Hono } from 'hono';

import { callerPrincipal, type CallerPrincipalEnv } from '../../caller-principal';
import { handleProtocolRequest, hasInvalidOrOversizedContentLength } from '../pipeline';
import { videoCapabilityNotSupported, videoForbidden, videoInvalidRequest, videoStoreFull } from './errors';
import { isValidVideoId, sameVideoOwner } from './job-store';
import { pinSuccessfulVideoJob } from './pin';
import { handlePinnedVideoRequest, invokePinnedVideo, resolveOwnedPinnedVideo, sourceVideoIdFromBody } from './pinned';
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

  app.post('/v1/videos/:video_id/remix', (context) => handleRemix(context, source));
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
  const peek = await peekFollowUpBody(context.req.raw);
  if (peek.kind === 'reject') return peek.response;
  if (peek.kind === 'json') {
    const sourceId = sourceVideoIdFromBody(peek.body);
    if (sourceId !== undefined && !isValidVideoId(sourceId)) return videoInvalidRequest('Invalid video id');
    if (isValidVideoId(sourceId)) {
      const record = source.videoJobs.lookup(sourceId);
      if (record !== undefined && !sameVideoOwner(record.owner, owner)) return videoForbidden();
      if (record !== undefined) {
        const parsed = videosTryParse(() => parseOpenAIVideoEdit(peek.body));
        if (!parsed.ok) return parsed.response;
        return await withCapacity(source, () =>
          invokePinnedVideo(context, source, record, {
            pinNewJob: true,
            modelId: parsed.value.modelDefaulted ? record.model : parsed.value.model,
          }),
        );
      }
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

async function handleRemix(context: Context<CallerPrincipalEnv>, source: VideosRouteSource) {
  const parsed = await peekFollowUpBody(context.req.raw);
  if (parsed.kind === 'reject') return parsed.response;
  if (parsed.kind !== 'json') return videosRequestError(new OpenAIVideosInvalidRequestError('content_type'));
  const remix = videosTryParse(() => parseOpenAIVideoRemix(parsed.body));
  if (!remix.ok) return remix.response;
  const resolved = resolveOwnedPinnedVideo(context, source);
  if ('response' in resolved) return resolved.response;
  return await withCapacity(source, () => invokePinnedVideo(context, source, resolved.record, { pinNewJob: true }));
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

type FollowUpPeek =
  | { readonly kind: 'json'; readonly body: unknown }
  | { readonly kind: 'reject'; readonly response: Response }
  | { readonly kind: 'unparsed' };

async function peekFollowUpBody(raw: Request): Promise<FollowUpPeek> {
  if (hasInvalidOrOversizedContentLength(raw, REQUEST_BODY_LIMITS)) {
    return { kind: 'reject', response: openAIVideosAdapter.errors.tooLarge() };
  }
  if (isMultipartRequest(raw) || !isJsonRequest(raw)) return { kind: 'unparsed' };
  try {
    return { kind: 'json', body: await readJsonRequest(raw.clone(), REQUEST_BODY_LIMITS) };
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return { kind: 'reject', response: openAIVideosAdapter.errors.tooLarge() };
    }
    return { kind: 'reject', response: videosRequestError(error) };
  }
}

function videosTryParse<T>(
  parse: () => T,
): { readonly ok: true; readonly value: T } | { readonly ok: false; readonly response: Response } {
  try {
    return { ok: true, value: parse() };
  } catch (error) {
    return { ok: false, response: videosRequestError(error) };
  }
}

function videosRequestError(error: unknown): Response {
  return openAIVideosAdapter.errors.requestError(error) ?? videoInvalidRequest('Invalid OpenAI Videos request');
}
