import { ProviderProtocol } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import type { CallerPrincipal } from '../../caller-principal';
import type { RuntimeProviderInstance } from '../../runtime';
import { logServerEvent } from '../../server-log';
import { expiresAtFromUpstream, isValidVideoId, type VideoJobRecord } from './job-store';
import type { VideosRouteSource } from './source';

export async function pinSuccessfulVideoJob(
  source: VideosRouteSource,
  owner: CallerPrincipal,
  info: { readonly provider: RuntimeProviderInstance; readonly modelId: string; readonly response: Response },
): Promise<void> {
  if (!info.response.ok) return;
  let body: unknown;
  try {
    body = await info.response.clone().json();
  } catch {
    logPinFailed(source, info.provider.id);
    return;
  }
  if (!isPlainObject(body) || !isValidVideoId(typeof body.id === 'string' ? body.id : undefined)) {
    logPinFailed(source, info.provider.id);
    return;
  }
  const createdAt = Date.now();
  const record: VideoJobRecord = {
    videoId: body.id,
    providerId: info.provider.id,
    ...(info.provider.accountId === undefined ? {} : { accountId: info.provider.accountId }),
    ...(info.provider.runtimeRevision === undefined ? {} : { runtimeRevision: info.provider.runtimeRevision }),
    model: info.modelId,
    owner,
    createdAt,
    expiresAt: expiresAtFromUpstream(body.expires_at, createdAt),
  };
  if (!source.videoJobs.insert(record)) logPinFailed(source, info.provider.id);
}

export function pinnedVideoProvider(
  providers: readonly RuntimeProviderInstance[],
  record: VideoJobRecord,
): RuntimeProviderInstance | undefined {
  const provider = providers.find((candidate) => candidate.id === record.providerId);
  if (provider === undefined || provider.enabled === false) return undefined;
  if (record.accountId !== undefined && provider.accountId !== record.accountId) return undefined;
  if (record.runtimeRevision !== undefined && provider.runtimeRevision !== record.runtimeRevision) return undefined;
  const raw = provider.raw?.resolve({ protocol: ProviderProtocol.OpenAIVideo, modelId: record.model });
  return raw === undefined ? undefined : provider;
}

function logPinFailed(source: VideosRouteSource, providerId: string): void {
  logServerEvent(source.logger, { event: 'video.job_pin_failed', providerId });
}
