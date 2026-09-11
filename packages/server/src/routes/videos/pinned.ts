import { ProviderProtocol } from '@aio-proxy/types';
import type { Context } from 'hono';

import { callerPrincipal, type CallerPrincipalEnv } from '../../caller-principal';
import { isInboundAbort } from '../../route-observation';
import { withoutCallerCredentialsOnRequest } from '../../server/api-key-auth';
import { cancelRetainedRequestBody } from '../pipeline/request';
import { videoForbidden, videoInvalidRequest, videoNotFound, videoUpstreamUnavailable } from './errors';
import { isValidVideoId, sameVideoOwner, type VideoJobRecord } from './job-store';
import { pinnedVideoProvider, pinSuccessfulVideoJob } from './pin';
import type { VideosRouteSource } from './source';

export function resolveOwnedPinnedVideo(
  context: Context<CallerPrincipalEnv>,
  source: VideosRouteSource,
): { readonly record: VideoJobRecord } | { readonly response: Response } {
  const videoId = context.req.param('video_id');
  if (!isValidVideoId(videoId)) return { response: videoInvalidRequest('Invalid video id') };
  const record = source.videoJobs.lookup(videoId);
  if (record === undefined) return { response: videoNotFound() };
  if (!sameVideoOwner(record.owner, callerPrincipal(context))) return { response: videoForbidden() };
  return { record };
}

export async function handlePinnedVideoRequest(
  context: Context<CallerPrincipalEnv>,
  source: VideosRouteSource,
  options: { readonly pinNewJob?: boolean } = {},
): Promise<Response> {
  const resolved = resolveOwnedPinnedVideo(context, source);
  if ('response' in resolved) return resolved.response;
  return await invokePinnedVideo(context, source, resolved.record, options);
}

export async function invokePinnedVideo(
  context: Context<CallerPrincipalEnv>,
  source: VideosRouteSource,
  record: VideoJobRecord,
  options: { readonly pinNewJob?: boolean; readonly modelId?: string; readonly request?: Request } = {},
): Promise<Response> {
  const lease = source.acquireProviderSnapshot();
  const modelId = options.modelId ?? record.model;
  const inbound = options.request ?? context.req.raw;
  // Sanitize before invoke so a keyless copy owns the body stream. Peek plus
  // that transfer can leave a full tee on this object after a 2xx/4xx that
  // never reads; cancel it whenever this call returns.
  const upstream = withoutCallerCredentialsOnRequest(inbound);
  try {
    const provider = pinnedVideoProvider(lease.snapshot.providers, record);
    const raw = provider?.raw?.resolve({
      protocol: ProviderProtocol.OpenAIVideo,
      modelId,
      requestPath: new URL(context.req.raw.url).pathname,
    });
    if (provider === undefined || raw === undefined) return videoUpstreamUnavailable();
    const response = await raw.invoke(upstream);
    if (context.req.method === 'DELETE' && response.ok) source.videoJobs.remove(record.videoId, record);
    if (options.pinNewJob === true && response.ok) {
      await pinSuccessfulVideoJob(source, callerPrincipal(context), {
        provider,
        modelId,
        response,
      });
    }
    return response;
  } catch (error) {
    if (isInboundAbort(error, context.req.raw.signal)) return new Response(null, { status: 499 });
    return videoUpstreamUnavailable();
  } finally {
    await cancelRetainedRequestBody(upstream, 'videos pinned request body no longer needed');
    lease.release();
  }
}
