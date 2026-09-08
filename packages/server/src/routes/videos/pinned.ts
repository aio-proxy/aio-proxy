import { ProviderProtocol } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';
import type { Context } from 'hono';

import { callerPrincipal, type CallerPrincipalEnv } from '../../caller-principal';
import { isInboundAbort } from '../../route-observation';
import { withoutCallerCredentialQuery } from '../../server/api-key-auth';
import { videoForbidden, videoInvalidRequest, videoNotFound, videoUpstreamUnavailable } from './errors';
import { isValidVideoId, sameVideoOwner, type VideoJobRecord } from './job-store';
import { pinnedVideoProvider, pinSuccessfulVideoJob } from './pin';
import type { VideosRouteSource } from './source';

export async function handlePinnedVideoRequest(
  context: Context<CallerPrincipalEnv>,
  source: VideosRouteSource,
  options: { readonly pinNewJob?: boolean } = {},
): Promise<Response> {
  const videoId = context.req.param('video_id');
  if (!isValidVideoId(videoId)) return videoInvalidRequest('Invalid video id');
  const record = source.videoJobs.lookup(videoId);
  if (record === undefined) return videoNotFound();
  if (!sameVideoOwner(record.owner, callerPrincipal(context))) return videoForbidden();
  return await invokePinnedVideo(context, source, record, options);
}

export async function invokePinnedVideo(
  context: Context<CallerPrincipalEnv>,
  source: VideosRouteSource,
  record: VideoJobRecord,
  options: { readonly pinNewJob?: boolean } = {},
): Promise<Response> {
  const lease = source.acquireProviderSnapshot();
  try {
    const provider = pinnedVideoProvider(lease.snapshot.providers, record);
    const raw = provider?.raw?.resolve({
      protocol: ProviderProtocol.OpenAIVideo,
      modelId: record.model,
      requestPath: new URL(context.req.raw.url).pathname,
    });
    if (provider === undefined || raw === undefined) return videoUpstreamUnavailable();
    const response = await raw.invoke(new Request(withoutCallerCredentialQuery(context.req.raw.url), context.req.raw));
    if (context.req.method === 'DELETE' && response.ok) source.videoJobs.remove(record.videoId, record);
    if (options.pinNewJob === true && response.ok) {
      await pinSuccessfulVideoJob(source, callerPrincipal(context), {
        provider,
        modelId: record.model,
        response,
      });
    }
    return response;
  } catch (error) {
    if (isInboundAbort(error, context.req.raw.signal)) return new Response(null, { status: 499 });
    return videoUpstreamUnavailable();
  } finally {
    lease.release();
  }
}

export function sourceVideoIdFromBody(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  const video = value.video;
  if (!isPlainObject(video) || typeof video.id !== 'string') return undefined;
  return video.id;
}
