import { ProviderKind } from '@aio-proxy/types';
import { isPlainObject } from 'es-toolkit/predicate';

import { logServerEvent, type ServerLogSink } from '../server-log';

export function leftoverOAuthModelProviderIds(raw: unknown): string[] {
  if (!isPlainObject(raw)) return [];
  const providers = raw['providers'];
  if (!isPlainObject(providers)) return [];
  const ids: string[] = [];
  for (const [id, entry] of Object.entries(providers)) {
    if (!isPlainObject(entry)) continue;
    if (entry['kind'] !== ProviderKind.OAuth) continue;
    if (Object.hasOwn(entry, 'models')) ids.push(id);
  }
  return ids;
}

export function warnLeftoverOAuthModels(raw: unknown, logger: ServerLogSink): void {
  for (const providerId of leftoverOAuthModelProviderIds(raw)) {
    logServerEvent(logger, { event: 'config.oauth_leftover_models', providerId });
  }
}
