import type { OAuthAdapter } from '@aio-proxy/plugin-sdk';

import type { AccountWrite, PluginRepository } from '../../../plugins/repository';
import { accountKey, encode } from '../../protocol';
import type { SyncObjectStore } from '../../publication';
import type { LocalBinding, LocalEntity, SyncRepository } from '../../repository';
import { decodeAccount, type LiveAccount } from '../protocol';

export function entityFor(repo: SyncRepository, binding: LocalBinding, providerId: string): LocalEntity | undefined {
  return repo.entities(binding.id).find((entity) => entity.logicalKey === providerId);
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

export async function readRemote(
  store: SyncObjectStore,
  objectId: string,
  signal: AbortSignal,
): Promise<{ account: LiveAccount; version: string } | null> {
  const value = await store.session.read(accountKey(objectId), signal);
  if (value.kind === 'absent') return null;
  const account = decodeAccount(value.value);
  if (account.phase === 'deleted' || account.objectId !== objectId) return null;
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

export function independentOwnership(account: LiveAccount, localRevision: number) {
  return {
    mode: 'independent' as const,
    epoch: account.epoch,
    generation: account.generation,
    localRevision,
    pluginVersion: account.pluginVersion,
    formatVersion: account.formatVersion,
  };
}

export function sharedOwnership(account: LiveAccount, localRevision: number) {
  return {
    mode: 'shared' as const,
    epoch: account.epoch,
    generation: account.generation,
    localRevision,
    pluginVersion: account.pluginVersion,
    formatVersion: account.formatVersion,
  };
}

export function accountBytes(account: LiveAccount): Uint8Array {
  return encode(account);
}

export type DetachContext = {
  readonly binding: LocalBinding;
  readonly repo: SyncRepository;
  readonly accounts: PluginRepository;
};
