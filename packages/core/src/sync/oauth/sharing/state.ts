import type { OAuthAdapter } from '@aio-proxy/plugin-sdk';

import type { AccountWrite, StoredAccount } from '../../../plugins/repository';
import { parsePluginSchema } from '../../../plugins/schema';
import type { OAuthJournalRow } from '../../repository';
import type { LiveAccount, OAuthOwnership } from '../protocol';
import { entityFor, payloadFor } from './detach';
import { asJournalPayload, journalJson, sameJson, type SharingJournalPayload } from './journal';
import type { OAuthSharingServiceInput } from './sharing';

export function accountWrite(account: StoredAccount): AccountWrite {
  return {
    providerId: account.providerId,
    plugin: account.plugin,
    capability: account.capability,
    fingerprint: account.fingerprint,
    options: account.options,
    secrets: account.secrets,
    credential: account.credential,
    ...(account.label === undefined ? {} : { label: account.label }),
    ...(account.expiresAt === undefined ? {} : { expiresAt: account.expiresAt }),
    catalog: { kind: 'preserve' },
  };
}

export function accountMatches(current: StoredAccount, candidate: AccountWrite): boolean {
  return (
    current.providerId === candidate.providerId &&
    current.plugin === candidate.plugin &&
    current.capability === candidate.capability &&
    current.fingerprint === candidate.fingerprint &&
    sameJson(current.options, candidate.options) &&
    sameJson(current.secrets, candidate.secrets) &&
    sameJson(current.credential, candidate.credential) &&
    current.label === candidate.label &&
    current.expiresAt === candidate.expiresAt
  );
}

export function ownership(account: LiveAccount, localRevision: number, mode: OAuthOwnership['mode']): OAuthOwnership {
  return {
    mode,
    epoch: account.epoch,
    generation: account.generation,
    localRevision,
    pluginVersion: account.pluginVersion,
    formatVersion: account.formatVersion,
    multiDeviceEvidenceId: account.multiDeviceEvidenceId,
  };
}

export function setPending(input: OAuthSharingServiceInput, providerId: string, reason: string, detach = false): void {
  const entity = entityFor(input.repo, input.binding, providerId);
  if (entity === undefined) return;
  input.repo.putEntity(input.binding.id, {
    ...entity,
    pendingReason: reason,
    ...(detach && entity.oauth !== undefined ? { oauth: { ...entity.oauth, mode: 'detach-pending' } } : {}),
  });
}

export function finishJournal(input: OAuthSharingServiceInput, row: OAuthJournalRow): void {
  input.repo.writeOAuthJournal(input.binding.id, { ...row, phase: 'complete' });
  input.repo.clearOAuthJournal(input.binding.id, row.operationId);
}

export function findJournal(
  input: OAuthSharingServiceInput,
  providerId: string,
  kind: SharingJournalPayload['kind'],
): { readonly row: OAuthJournalRow; readonly payload: SharingJournalPayload } | undefined {
  for (const row of input.repo.oauthJournals(input.binding.id)) {
    const payload = asJournalPayload(row.payload);
    if (payload?.providerId === providerId && payload.kind === kind) return { row, payload };
  }
  return undefined;
}

export function writeJournal(
  input: OAuthSharingServiceInput,
  payload: SharingJournalPayload,
  identity: { readonly objectId: string; readonly epoch: number; readonly generation: number },
): OAuthJournalRow {
  const row: OAuthJournalRow = {
    operationId: crypto.randomUUID(),
    objectId: identity.objectId,
    epoch: identity.epoch,
    baseGeneration: identity.generation,
    phase: 'started',
    payload: journalJson(payload),
  };
  input.repo.writeOAuthJournal(input.binding.id, row);
  return row;
}

export async function validatedAdapter(
  input: OAuthSharingServiceInput,
  providerId: string,
  candidate: AccountWrite,
): Promise<{ readonly adapter: OAuthAdapter; readonly pluginVersion: string } | undefined> {
  let resolved: ReturnType<OAuthSharingServiceInput['resolveAdapter']>;
  try {
    resolved = input.resolveAdapter(providerId);
  } catch {
    return undefined;
  }
  const sync = resolved.adapter.credentialSync;
  if (
    candidate.providerId !== providerId ||
    resolved.adapter.id !== candidate.capability ||
    sync?.formatVersion !== 1 ||
    (sync.multiDevice?.evidenceId.length ?? 0) === 0
  )
    return undefined;
  const parsed = await parsePluginSchema(resolved.adapter.credentials, candidate.credential);
  return parsed.ok ? resolved : undefined;
}

export function compatibleRemote(
  remote: LiveAccount,
  candidate: AccountWrite,
  resolved: { readonly adapter: OAuthAdapter; readonly pluginVersion: string },
): boolean {
  return (
    remote.plugin === candidate.plugin &&
    remote.capability === candidate.capability &&
    remote.pluginVersion === resolved.pluginVersion &&
    remote.formatVersion === resolved.adapter.credentialSync?.formatVersion &&
    remote.multiDeviceEvidenceId === resolved.adapter.credentialSync?.multiDevice?.evidenceId
  );
}

function ownedRemote(ownership: OAuthOwnership, remote: LiveAccount): boolean {
  return (
    ownership.epoch === remote.epoch &&
    ownership.generation === remote.generation &&
    ownership.pluginVersion === remote.pluginVersion &&
    ownership.formatVersion === remote.formatVersion &&
    ownership.multiDeviceEvidenceId === remote.multiDeviceEvidenceId
  );
}

export function readyOwnedRemote(ownership: OAuthOwnership, remote: LiveAccount): boolean {
  return remote.phase === 'ready' && remote.claim === null && ownedRemote(ownership, remote);
}

/**
 * An abandoned refresh leaves the shared account behind a claim that nothing clears on its own:
 * `uncertain` when the exchange outcome was lost, `login-required` when its result failed
 * validation. Neither phase returns to `ready` by itself, so a device still owning that exact
 * generation has to be allowed to recover from both. The recovery paths take over rather than
 * resume: replacing advances the epoch, which is what makes a late-landing result from the
 * abandoned exchange fail instead of resurrect the account.
 */
export function abandonedOwnedRemote(ownership: OAuthOwnership, remote: LiveAccount): boolean {
  return (remote.phase === 'uncertain' || remote.phase === 'login-required') && ownedRemote(ownership, remote);
}

export function liveAccount(
  objectId: string,
  candidate: AccountWrite,
  resolved: { readonly adapter: OAuthAdapter; readonly pluginVersion: string },
  generation: number,
  epoch = 0,
): LiveAccount {
  return {
    protocol: 1,
    objectId,
    epoch,
    plugin: candidate.plugin,
    capability: candidate.capability,
    pluginVersion: resolved.pluginVersion,
    formatVersion: resolved.adapter.credentialSync!.formatVersion,
    multiDeviceEvidenceId: resolved.adapter.credentialSync!.multiDevice!.evidenceId,
    generation,
    phase: 'ready',
    payload: payloadFor(candidate),
    claim: null,
    lastCompletedOperationId: null,
  };
}

export function applyLocal(
  input: OAuthSharingServiceInput,
  providerId: string,
  candidate: AccountWrite,
  remote: LiveAccount,
  row: OAuthJournalRow,
  mode: 'shared' | 'independent',
): void {
  // Reopen resets SQLite's connection-level synchronous setting. Establish FULL
  // before entering the transaction that commits the account and clears its journal.
  input.repo.writeOAuthJournal(input.binding.id, row);
  input.accounts.withAccountTransaction(() => {
    let current = input.accounts.readAccount(providerId);
    if (current === null) throw new Error('SYNC_OAUTH_ACCOUNT_MISSING');
    if (!accountMatches(current, candidate)) {
      const pending = input.accounts.stageAccountOperation({
        kind: 'update',
        targetDigest: `sync:${remote.objectId}:${remote.epoch}:${remote.generation}`,
        expectedRuntimeRevision: current.runtimeRevision,
        account: candidate,
      });
      input.accounts.completeAccountOperation(pending.operationId);
      current = input.accounts.readAccount(providerId);
      if (current === null) throw new Error('SYNC_OAUTH_ACCOUNT_MISSING');
    }
    const entity = entityFor(input.repo, input.binding, providerId);
    if (entity === undefined || entity.objectId !== remote.objectId) throw new Error('SYNC_OAUTH_ENTITY_MISSING');
    input.repo.putEntity(input.binding.id, {
      ...entity,
      pendingReason: null,
      oauth: ownership(remote, current.revision, mode),
    });
    finishJournal(input, row);
  });
}
