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

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function sameRemote(left: LiveAccount, right: LiveAccount): boolean {
  return (
    left.protocol === right.protocol &&
    left.objectId === right.objectId &&
    left.epoch === right.epoch &&
    left.plugin === right.plugin &&
    left.capability === right.capability &&
    left.pluginVersion === right.pluginVersion &&
    left.formatVersion === right.formatVersion &&
    left.multiDeviceEvidenceId === right.multiDeviceEvidenceId &&
    left.generation === right.generation &&
    left.phase === right.phase &&
    sameJson(left.payload, right.payload) &&
    sameJson(left.claim, right.claim) &&
    left.lastCompletedOperationId === right.lastCompletedOperationId
  );
}
