import type { JsonValue } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import type { AccountWrite } from '../../../plugins/repository';
import type { LiveAccount } from '../protocol';

export type SharingOperation = 'share' | 'replace' | 'detach';

export type SharingJournalPayload = {
  readonly schema: 'oauth-sharing-v1';
  readonly kind: SharingOperation;
  readonly providerId: string;
  readonly candidate: AccountWrite;
  readonly base: LiveAccount | null;
  readonly next: LiveAccount | null;
};

export function asJournalPayload(value: JsonValue | null): SharingJournalPayload | undefined {
  if (!isPlainObject(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record['schema'] !== 'oauth-sharing-v1') return undefined;
  if (!['share', 'replace', 'detach'].includes(String(record['kind']))) return undefined;
  if (typeof record['providerId'] !== 'string' || !isPlainObject(record['candidate'])) return undefined;
  return value as unknown as SharingJournalPayload;
}

export function journalJson(payload: SharingJournalPayload): JsonValue {
  return payload as unknown as JsonValue;
}
