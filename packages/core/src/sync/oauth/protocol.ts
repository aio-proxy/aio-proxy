import type { JsonValue, OAuthAdapter } from '@aio-proxy/plugin-sdk';
import { z } from 'zod';

import { type DeletedAccount, SyncProtocolError } from '../protocol';

export class SyncOAuthError extends Error {
  override readonly name = 'SyncOAuthError';

  constructor(
    readonly code:
      | 'refresh-deferred'
      | 'result-uncertain'
      | 'login-required'
      | 'deleted'
      | 'upgrade-required'
      | 'unverified'
      | 'detach-pending',
    message: string = code,
  ) {
    super(message);
  }
}

export interface AccountPayload {
  credential: JsonValue;
  options: JsonValue;
  secrets: JsonValue;
  fingerprint: string;
  label?: string;
  expiresAt?: number;
}

export interface RefreshClaim {
  operationId: string;
  ownerDeviceId: string;
  baseGeneration: number;
}

export interface LiveAccount {
  protocol: 1;
  objectId: string;
  epoch: number;
  plugin: string;
  capability: string;
  pluginVersion: string;
  formatVersion: number;
  generation: number;
  phase: 'ready' | 'refreshing' | 'uncertain' | 'login-required';
  payload: AccountPayload;
  claim: RefreshClaim | null;
  lastCompletedOperationId: string | null;
}

export type AccountRecord = LiveAccount | DeletedAccount;

export interface OAuthOwnership {
  mode: 'shared' | 'detach-pending' | 'independent';
  epoch: number;
  generation: number;
  localRevision: number;
  pluginVersion: string;
  formatVersion: number;
}

const accountPayloadSchema = z.object({
  credential: z.unknown(),
  options: z.unknown(),
  secrets: z.unknown(),
  fingerprint: z.string(),
  label: z.string().optional(),
  expiresAt: z.number().finite().optional(),
});
const refreshClaimSchema = z.object({
  operationId: z.string(),
  ownerDeviceId: z.string(),
  baseGeneration: z.number().int().nonnegative(),
});
const liveAccountSchema = z.object({
  protocol: z.literal(1),
  objectId: z.string(),
  epoch: z.number().int().nonnegative(),
  plugin: z.string(),
  capability: z.string(),
  pluginVersion: z.string(),
  formatVersion: z.literal(1),
  generation: z.number().int().nonnegative(),
  phase: z.enum(['ready', 'refreshing', 'uncertain', 'login-required']),
  payload: accountPayloadSchema,
  claim: refreshClaimSchema.nullable(),
  lastCompletedOperationId: z.string().nullable(),
});
const deletedAccountSchema = z.object({
  protocol: z.literal(1),
  phase: z.literal('deleted'),
  objectId: z.string(),
  epoch: z.number().int().nonnegative(),
});

export function decodeAccount(bytes: Uint8Array): AccountRecord {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new SyncProtocolError('invalid-data', 'invalid JSON');
  }
  if (typeof value !== 'object' || value === null || !('protocol' in value) || value.protocol !== 1) {
    throw new SyncProtocolError('upgrade-required', 'upgrade-required: unsupported account protocol');
  }
  const parsed =
    'phase' in value && value.phase === 'deleted'
      ? deletedAccountSchema.safeParse(value)
      : liveAccountSchema.safeParse(value);
  if (!parsed.success) throw new SyncProtocolError('upgrade-required', 'upgrade-required: unsupported account format');
  return parsed.data as AccountRecord;
}

export function canActivateSyncedAccount(adapter: OAuthAdapter, pluginVersion: string, account: LiveAccount): boolean {
  const sync = adapter.credentialSync;
  return (
    account.phase === 'ready' &&
    sync !== undefined &&
    sync.formatVersion === account.formatVersion &&
    pluginVersion === account.pluginVersion &&
    (sync.multiDevice?.evidenceId.length ?? 0) > 0
  );
}
