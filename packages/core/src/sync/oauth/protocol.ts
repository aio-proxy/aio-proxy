import type { JsonValue, OAuthAdapter } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';
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
  multiDeviceEvidenceId?: string;
  generation: number;
  phase: 'ready' | 'refreshing' | 'uncertain' | 'login-required';
  payload: AccountPayload;
  claim: RefreshClaim | null;
  lastCompletedOperationId: string | null;
}

export type AccountRecord = LiveAccount | DeletedAccount;

export interface OAuthOwnership {
  mode: 'shared' | 'share-pending' | 'detach-pending' | 'independent';
  epoch: number;
  generation: number;
  localRevision: number;
  pluginVersion: string;
  formatVersion: number;
  multiDeviceEvidenceId?: string;
}

/**
 * The journal payload's operation, read structurally: the full parser lives with the sharing
 * service, which builds on this module.
 */
function journalKind(payload: JsonValue | null | undefined): string | undefined {
  if (!isPlainObject(payload)) return undefined;
  const kind = (payload as Record<string, JsonValue>)['kind'];
  return typeof kind === 'string' ? kind : undefined;
}

/**
 * Whether this row still speaks for a credential other devices may be following: it holds
 * ownership that is not `independent`, or an OAuth operation is journalled against its object and
 * may have published the credential before it was interrupted. Either way the local credential
 * port must not rotate the refresh token on its own, and the binding must not be retired while the
 * hold stands — nothing can target an inactive lifecycle, so a surviving hold could never be
 * detached.
 *
 * A first share that has not reached the backend is the exception. Its journal and its
 * `share-pending` ownership are both written before the account object's first write, so while the
 * row is still `started` this device demonstrably never published the credential. Counting that as
 * a hold wedges the binding for good: a share interrupted offline leaves a connect Apply
 * unfinished, whose only recovery is a fresh connect, and the swap and `disconnect` would both
 * refuse it as `detach-required` while detaching cannot clear a claim on an account object that
 * does not exist.
 *
 * `share()` advances the row to `result` before dispatching that write, because confirming it is a
 * separate transaction from the one that clears the journal and moves the row to `shared`: a lost
 * reply or an exit in between leaves both excluded states standing over a credential other devices
 * can already be following. Only `started` proves the write never went out.
 */
export function retainsSharedOAuth(
  entity: { readonly objectId: string; readonly oauth?: OAuthOwnership },
  journals: readonly {
    readonly objectId: string;
    readonly phase: 'started' | 'result' | 'complete';
    readonly payload?: JsonValue | null;
  }[],
): boolean {
  return (
    (entity.oauth !== undefined && entity.oauth.mode !== 'independent' && entity.oauth.mode !== 'share-pending') ||
    journals.some(
      (row) => row.objectId === entity.objectId && (journalKind(row.payload) !== 'share' || row.phase !== 'started'),
    )
  );
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
  multiDeviceEvidenceId: z.string().optional(),
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
    (sync.multiDevice?.evidenceId.length ?? 0) > 0 &&
    account.multiDeviceEvidenceId === sync.multiDevice?.evidenceId
  );
}
