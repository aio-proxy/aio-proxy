import {
  isJsonRequest,
  isMultipartRequest,
  openAIVideosAdapter,
  OpenAIVideosInvalidRequestError,
  parseOpenAIVideoEdit,
  parseOpenAIVideoRemix,
  readJsonRequest,
  releaseMultipartSpool,
  REQUEST_BODY_LIMITS,
  RequestBodyTooLargeError,
  stripHopHeaders,
  UnsupportedContentEncodingError,
} from '@aio-proxy/core';
import { isPlainObject } from 'es-toolkit/predicate';
import { type Context, Hono } from 'hono';

import { callerPrincipal, type CallerPrincipalEnv } from '../../caller-principal';
import { handleProtocolRequest, hasInvalidOrOversizedContentLength } from '../pipeline';
import { cancelRetainedRequestBody } from '../pipeline/request';
import { videoCapabilityNotSupported, videoForbidden, videoInvalidRequest, videoStoreFull } from './errors';
import { isValidVideoId, sameVideoOwner } from './job-store';
import { pinSuccessfulVideoJob } from './pin';
import { handlePinnedVideoRequest, invokePinnedVideo, resolveOwnedPinnedVideo } from './pinned';
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
  const raw = context.req.raw;
  if (hasInvalidOrOversizedContentLength(raw, REQUEST_BODY_LIMITS)) {
    return await rejectFollowUp(raw, openAIVideosAdapter.errors.tooLarge());
  }
  const parsed = await videosTryParseAsync(() => openAIVideosAdapter.parse(raw, { operation: 'create' }));
  if (!parsed.ok) return await rejectFollowUp(raw, parsed.response);
  return await withCapacity(source, raw, () =>
    handleProtocolRequest({
      adapter: openAIVideosAdapter,
      context: { operation: 'create' },
      rawRequest: raw,
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
  const raw = context.req.raw;
  const peek = await peekFollowUpBody(raw);
  if (peek.kind === 'reject') return await rejectFollowUp(raw, peek.response);
  if (peek.kind !== 'json') {
    return await rejectFollowUp(raw, videosRequestError(new OpenAIVideosInvalidRequestError('content_type')));
  }
  const parsed = videosTryParse(() => parseOpenAIVideoEdit(peek.body));
  if (!parsed.ok) return await rejectFollowUp(raw, parsed.response);
  const sourceId = parsed.value.sourceVideoId;
  if (!isValidVideoId(sourceId)) return await rejectFollowUp(raw, videoInvalidRequest('Invalid video id'));
  const record = source.videoJobs.lookup(sourceId);
  if (record !== undefined && !sameVideoOwner(record.owner, owner)) {
    return await rejectFollowUp(raw, videoForbidden());
  }
  if (record !== undefined) {
    const modelId = parsed.value.modelDefaulted ? record.model : parsed.value.model;
    const rewritten =
      isPlainObject(peek.body) && (parsed.value.modelDefaulted || parsed.value.clientModel !== modelId)
        ? jsonFollowUpRequest(raw, { ...peek.body, model: modelId })
        : undefined;
    if (rewritten !== undefined) await cancelRetainedRequestBody(raw, 'videos pinned follow-up rewritten');
    return await withCapacity(source, raw, () =>
      invokePinnedVideo(context, source, record, {
        pinNewJob: true,
        modelId,
        ...(rewritten === undefined ? {} : { request: rewritten }),
      }),
    );
  }
  return await withCapacity(source, raw, () =>
    handleProtocolRequest({
      adapter: openAIVideosAdapter,
      context: { operation },
      rawRequest: raw,
      source,
      onSuccessfulAttempt: (info) => pinSuccessfulVideoJob(source, owner, info),
    }),
  );
}

async function handleRemix(context: Context<CallerPrincipalEnv>, source: VideosRouteSource) {
  const raw = context.req.raw;
  const parsed = await peekFollowUpBody(raw);
  if (parsed.kind === 'reject') return await rejectFollowUp(raw, parsed.response);
  if (parsed.kind !== 'json') {
    return await rejectFollowUp(raw, videosRequestError(new OpenAIVideosInvalidRequestError('content_type')));
  }
  const remix = videosTryParse(() => parseOpenAIVideoRemix(parsed.body));
  if (!remix.ok) return await rejectFollowUp(raw, remix.response);
  const resolved = resolveOwnedPinnedVideo(context, source);
  if ('response' in resolved) return await rejectFollowUp(raw, resolved.response);
  return await withCapacity(source, raw, () =>
    invokePinnedVideo(context, source, resolved.record, { pinNewJob: true }),
  );
}

async function withCapacity(source: VideosRouteSource, raw: Request, run: () => Promise<Response>): Promise<Response> {
  const slot = source.videoJobs.reserveCapacity();
  if (slot === undefined) return await rejectFollowUp(raw, videoStoreFull());
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
    return { kind: 'json', body: await readJsonRequest(raw, REQUEST_BODY_LIMITS) };
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return { kind: 'reject', response: openAIVideosAdapter.errors.tooLarge() };
    }
    if (error instanceof UnsupportedContentEncodingError) {
      return { kind: 'reject', response: openAIVideosAdapter.errors.unsupportedContentEncoding() };
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

async function videosTryParseAsync<T>(
  parse: () => Promise<T>,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly response: Response }> {
  try {
    return { ok: true, value: await parse() };
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return { ok: false, response: openAIVideosAdapter.errors.tooLarge() };
    }
    if (error instanceof UnsupportedContentEncodingError) {
      return { ok: false, response: openAIVideosAdapter.errors.unsupportedContentEncoding() };
    }
    return { ok: false, response: videosRequestError(error) };
  }
}

function videosRequestError(error: unknown): Response {
  return openAIVideosAdapter.errors.requestError(error) ?? videoInvalidRequest('Invalid OpenAI Videos request');
}

async function rejectFollowUp(raw: Request, response: Response): Promise<Response> {
  await releaseMultipartSpool(raw);
  await cancelRetainedRequestBody(raw, 'videos follow-up rejected');
  return response;
}

function jsonFollowUpRequest(raw: Request, body: Record<string, unknown>): Request {
  const headers = stripHopHeaders(raw.headers);
  headers.set('content-type', 'application/json');
  return new Request(raw, { method: raw.method, headers, body: JSON.stringify(body), signal: raw.signal });
}
