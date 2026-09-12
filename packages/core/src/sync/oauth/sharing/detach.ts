import type { OAuthAdapter } from '@aio-proxy/plugin-sdk';

import type { AccountWrite } from '../../../plugins/repository';
import { accountKey, encode } from '../../protocol';
import type { DeletedAccount } from '../../protocol';
import type { SyncObjectStore } from '../../publication';
import type { LocalBinding, LocalEntity, SyncRepository } from '../../repository';
import { decodeAccount, type LiveAccount } from '../protocol';

export function entityFor(repo: SyncRepository, binding: LocalBinding, providerId: string): LocalEntity | undefined {
  // A model rule or plugin row can carry the same logical key as an OAuth Provider ID. Coordinating
  // credentials under that row would attach ownership to an unrelated object.
  return repo.entities(binding.id).find((entity) => entity.kind === 'provider' && entity.logicalKey === providerId);
}

export function payloadFor(candidate: AccountWrite): LiveAccount['payload'] {
  return {
    credential: candidate.credential as LiveAccount['payload']['credential'],
    options: candidate.options as LiveAccount['payload']['options'],
    secrets: candidate.secrets as LiveAccount['payload']['secrets'],
    fingerprint: candidate.fingerprint,
    ...(candidate.label === undefined ? {} : { label: candidate.label }),
    ...(candidate.expiresAt === undefined ? {} : { expiresAt: candidate.expiresAt }),
  };
}

/**
 * A tombstone is reported separately rather than as `null`: the key is present, so a caller that
 * treats it as absent and compare-and-swaps against `null` can never write. Only `share()` acts on
 * it — everyone else reads it exactly as they read an absent account.
 */
export async function readRemote(
  store: SyncObjectStore,
  objectId: string,
  signal: AbortSignal,
): Promise<
  { account: LiveAccount; version: string } | { deleted: DeletedAccount; version: string } | { unknown: true } | null
> {
  const value = await store.session.read(accountKey(objectId), signal);
  if (value.kind === 'absent') return null;
  let account: ReturnType<typeof decodeAccount>;
  try {
    account = decodeAccount(value.value);
  } catch {
    return { unknown: true };
  }
  if (account.objectId !== objectId) return null;
  if (account.phase === 'deleted') return { deleted: account, version: value.version };
  return { account, version: value.version };
}

export async function verifyDetach(
  adapter: OAuthAdapter,
  shared: unknown,
  candidate: AccountWrite,
  signal: AbortSignal,
): Promise<boolean> {
  const canDetach = adapter.credentialSync?.canDetach;
  if (canDetach === undefined) return false;
  return canDetach({ shared, candidate: candidate.credential, signal });
}

export function accountBytes(account: LiveAccount): Uint8Array {
  return encode(account);
}
