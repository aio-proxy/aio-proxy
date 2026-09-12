import { isPlainObject } from 'es-toolkit/predicate';

import type { CallerPrincipal } from '../../caller-principal';
import type { RuntimeProviderInstance } from '../../runtime';
import { logServerEvent } from '../../server-log';
import { createIdleTimer } from '../../usage-capture';
import { expiresAtFromUpstream, isValidVideoId, type VideoJobRecord } from './job-store';
import type { VideosRouteSource } from './source';

/** Official job JSON is a few hundred bytes. Anything larger is treated as a
 *  failed pin so a never-ending 2xx cannot hang the success hook. */
export const VIDEO_JOB_JSON_LIMIT = 64 * 1024;
const VIDEO_JOB_JSON_IDLE_MS = 10_000;

export async function pinSuccessfulVideoJob(
  source: VideosRouteSource,
  owner: CallerPrincipal,
  info: { readonly provider: RuntimeProviderInstance; readonly modelId: string; readonly response: Response },
): Promise<void> {
  try {
    if (!info.response.ok) return;
    const body = await readVideoJobJson(info.response);
    if (body === undefined) {
      logPinFailed(source, info.provider.id);
      return;
    }
    if (!isPlainObject(body)) {
      logPinFailed(source, info.provider.id);
      return;
    }
    const videoId = body['id'];
    if (!isValidVideoId(typeof videoId === 'string' ? videoId : undefined)) {
      logPinFailed(source, info.provider.id);
      return;
    }
    const createdAt = Date.now();
    const record: VideoJobRecord = {
      videoId,
      providerId: info.provider.id,
      ...(info.provider.accountId === undefined ? {} : { accountId: info.provider.accountId }),
      ...(info.provider.runtimeRevision === undefined ? {} : { runtimeRevision: info.provider.runtimeRevision }),
      model: info.modelId,
      owner,
      createdAt,
      expiresAt: expiresAtFromUpstream(body['expires_at'], createdAt),
    };
    if (!source.videoJobs.insert(record)) logPinFailed(source, info.provider.id);
  } catch {
    logPinFailed(source, info.provider.id);
  }
}

export function pinnedVideoProvider(
  providers: readonly RuntimeProviderInstance[],
  record: VideoJobRecord,
): RuntimeProviderInstance | undefined {
  const provider = providers.find((candidate) => candidate.id === record.providerId);
  if (provider === undefined || provider.enabled === false) return undefined;
  if (record.accountId !== undefined && provider.accountId !== record.accountId) return undefined;
  if (record.runtimeRevision !== undefined && provider.runtimeRevision !== record.runtimeRevision) return undefined;
  return provider;
}

function logPinFailed(source: VideosRouteSource, providerId: string): void {
  logServerEvent(source.logger, { event: 'video.job_pin_failed', providerId });
}

async function readVideoJobJson(response: Response): Promise<unknown> {
  if (response.body === null) return undefined;
  const reader = response.clone().body?.getReader();
  if (reader === undefined) return undefined;
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const abandon = () => {
    void reader.cancel().catch(() => undefined);
  };
  const idle = createIdleTimer(VIDEO_JOB_JSON_IDLE_MS, abandon);
  try {
    idle.arm();
    for (;;) {
      const chunk = await reader.read();
      idle.arm();
      if (chunk.done) break;
      byteLength += chunk.value.byteLength;
      if (byteLength > VIDEO_JOB_JSON_LIMIT) {
        abandon();
        return undefined;
      }
      chunks.push(chunk.value);
    }
  } catch {
    abandon();
    return undefined;
  } finally {
    idle.clear();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}
