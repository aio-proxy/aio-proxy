import type { OAuthAdapter } from '@aio-proxy/plugin-sdk';
import { SyncBackendError } from '@aio-proxy/plugin-sdk';

import type { AccountWrite, PluginRepository, StoredAccount } from '../../../plugins/repository';
import { parsePluginSchema } from '../../../plugins/schema';
import { accountKey } from '../../protocol';
import type { SyncObjectStore } from '../../publication';
import type { LocalBinding, OAuthJournalRow, SyncRepository } from '../../repository';
import type { LiveAccount, OAuthOwnership } from '../protocol';
import { accountBytes, entityFor, payloadFor, readRemote, verifyDetach } from './detach';
import { asJournalPayload, journalJson, sameJson, sameRemote, type SharingJournalPayload } from './journal';

export interface OAuthSharingService {
  share(providerId: string, signal: AbortSignal): Promise<'shared' | 'pending'>;
  replaceShared(providerId: string, candidate: AccountWrite, signal: AbortSignal): Promise<void>;
  detach(providerId: string, candidate: AccountWrite, signal: AbortSignal): Promise<'independent' | 'pending'>;
  cancelDetach(providerId: string): void;
  recover(signal: AbortSignal): Promise<void>;
  synchronizeLogin(providerId: string, candidate: AccountWrite, signal: AbortSignal): Promise<void>;
}

export interface OAuthSharingServiceInput {
  readonly binding: LocalBinding;
  readonly repo: SyncRepository;
  readonly accounts: PluginRepository;
  readonly store: SyncObjectStore;
  resolveAdapter(providerId: string): { adapter: OAuthAdapter; pluginVersion: string };
  withProviderGate<T>(providerId: string, run: () => Promise<T>): Promise<T>;
}

function accountWrite(account: StoredAccount): AccountWrite {
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

function accountMatches(current: StoredAccount, candidate: AccountWrite): boolean {
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

function ownership(account: LiveAccount, localRevision: number, mode: OAuthOwnership['mode']): OAuthOwnership {
  return {
    mode,
    epoch: account.epoch,
    generation: account.generation,
    localRevision,
    pluginVersion: account.pluginVersion,
    formatVersion: account.formatVersion,
  };
}

function setPending(input: OAuthSharingServiceInput, providerId: string, reason: string, detach = false): void {
  const entity = entityFor(input.repo, input.binding, providerId);
  if (entity === undefined) return;
  input.repo.putEntity(input.binding.id, {
    ...entity,
    pendingReason: reason,
    ...(detach && entity.oauth !== undefined ? { oauth: { ...entity.oauth, mode: 'detach-pending' } } : {}),
  });
}

function finishJournal(input: OAuthSharingServiceInput, row: OAuthJournalRow): void {
  input.repo.writeOAuthJournal(input.binding.id, { ...row, phase: 'complete' });
  input.repo.clearOAuthJournal(input.binding.id, row.operationId);
}

function findJournal(
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

function writeJournal(
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

async function validatedAdapter(
  input: OAuthSharingServiceInput,
  providerId: string,
  candidate: AccountWrite,
): Promise<{ readonly adapter: OAuthAdapter; readonly pluginVersion: string } | undefined> {
  const resolved = input.resolveAdapter(providerId);
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

function compatibleRemote(
  remote: LiveAccount,
  candidate: AccountWrite,
  resolved: { readonly adapter: OAuthAdapter; readonly pluginVersion: string },
): boolean {
  return (
    remote.plugin === candidate.plugin &&
    remote.capability === candidate.capability &&
    remote.pluginVersion === resolved.pluginVersion &&
    remote.formatVersion === resolved.adapter.credentialSync?.formatVersion
  );
}

function readyOwnedRemote(ownership: OAuthOwnership, remote: LiveAccount): boolean {
  return (
    remote.phase === 'ready' &&
    remote.claim === null &&
    ownership.epoch === remote.epoch &&
    ownership.generation === remote.generation &&
    ownership.pluginVersion === remote.pluginVersion &&
    ownership.formatVersion === remote.formatVersion
  );
}

function liveAccount(
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
    generation,
    phase: 'ready',
    payload: payloadFor(candidate),
    claim: null,
    lastCompletedOperationId: null,
  };
}

function applyLocal(
  input: OAuthSharingServiceInput,
  providerId: string,
  candidate: AccountWrite,
  remote: LiveAccount,
  row: OAuthJournalRow,
  mode: 'shared' | 'independent',
): void {
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

// eslint-disable-next-line max-lines-per-function
export function createOAuthSharingService(input: OAuthSharingServiceInput): OAuthSharingService {
  async function share(providerId: string, signal: AbortSignal): Promise<'shared' | 'pending'> {
    return input.withProviderGate(providerId, async () => {
      const local = input.accounts.readAccount(providerId);
      const entity = entityFor(input.repo, input.binding, providerId);
      if (local === null || entity === undefined) return 'pending';
      const candidate = accountWrite(local);
      const resolved = await validatedAdapter(input, providerId, candidate);
      if (resolved === undefined) {
        setPending(input, providerId, 'pending-plugin-update');
        return 'pending';
      }
      const pending = findJournal(input, providerId, 'share');
      const next = pending?.payload.next ?? liveAccount(entity.objectId, candidate, resolved, 0);
      if (next === null || !sameJson(pending?.payload.candidate ?? candidate, candidate)) return 'pending';
      const remote = await readRemote(input.store, entity.objectId, signal);
      if (remote !== null && 'unknown' in remote) {
        setPending(input, providerId, 'pending-plugin-update');
        return 'pending';
      }
      if (remote !== null) {
        if (!compatibleRemote(remote.account, candidate, resolved) || !sameRemote(remote.account, next)) {
          setPending(input, providerId, 'pending-plugin-update');
          return 'pending';
        }
        const row =
          pending?.row ??
          writeJournal(
            input,
            { schema: 'oauth-sharing-v1', kind: 'share', providerId, candidate, base: null, next },
            { objectId: next.objectId, epoch: next.epoch, generation: 0 },
          );
        applyLocal(input, providerId, candidate, remote.account, row, 'shared');
        return 'shared';
      }
      if (entity.oauth?.mode === 'shared' || entity.oauth?.mode === 'detach-pending') {
        setPending(input, providerId, 'detach-pending');
        return 'pending';
      }
      const row =
        pending?.row ??
        writeJournal(
          input,
          { schema: 'oauth-sharing-v1', kind: 'share', providerId, candidate, base: null, next },
          { objectId: next.objectId, epoch: next.epoch, generation: 0 },
        );
      try {
        const result = await input.store.session.compareAndSwap(
          accountKey(next.objectId),
          null,
          accountBytes(next),
          signal,
        );
        if (result.kind !== 'written') return 'pending';
      } catch (error) {
        if (!(error instanceof SyncBackendError) || error.code !== 'outcome-unknown') throw error;
        const observed = await readRemote(input.store, next.objectId, signal);
        if (observed === null || 'unknown' in observed || !sameRemote(observed.account, next)) return 'pending';
      }
      applyLocal(input, providerId, candidate, next, row, 'shared');
      return 'shared';
    });
  }

  async function replaceShared(providerId: string, candidate: AccountWrite, signal: AbortSignal): Promise<void> {
    return input.withProviderGate(providerId, async () => {
      const entity = entityFor(input.repo, input.binding, providerId);
      if (entity?.oauth === undefined || entity.oauth.mode === 'independent')
        throw new Error('SYNC_OAUTH_ACCOUNT_MISSING');
      const resolved = await validatedAdapter(input, providerId, candidate);
      if (resolved === undefined) throw new Error('SYNC_OAUTH_UPGRADE_REQUIRED');
      const pending = findJournal(input, providerId, 'replace');
      if (pending !== undefined && !sameJson(pending.payload.candidate, candidate)) {
        throw new Error('SYNC_OAUTH_REPLACEMENT_PENDING');
      }
      const remote = await readRemote(input.store, entity.objectId, signal);
      if (remote === null || 'unknown' in remote) throw new Error('SYNC_OAUTH_ACCOUNT_MISSING');
      if (!compatibleRemote(remote.account, candidate, resolved)) throw new Error('SYNC_OAUTH_UPGRADE_REQUIRED');
      if (pending === undefined && !readyOwnedRemote(entity.oauth, remote.account)) {
        throw new Error('SYNC_OAUTH_REPLACEMENT_PENDING');
      }
      if (pending !== undefined) {
        const expected = pending.payload.next;
        if (expected === null) throw new Error('SYNC_OAUTH_REPLACEMENT_PENDING');
        if (sameRemote(remote.account, expected)) {
          applyLocal(input, providerId, candidate, expected, pending.row, 'shared');
          return;
        }
        if (pending.payload.base === null || !sameRemote(remote.account, pending.payload.base)) {
          throw new Error('SYNC_OAUTH_REPLACEMENT_CONFLICT');
        }
      }
      const base = pending?.payload.base ?? remote.account;
      const next =
        pending?.payload.next ??
        liveAccount(remote.account.objectId, candidate, resolved, remote.account.generation + 1, remote.account.epoch);
      if (base === null || next === null) throw new Error('SYNC_OAUTH_REPLACEMENT_PENDING');
      const row =
        pending?.row ??
        writeJournal(
          input,
          { schema: 'oauth-sharing-v1', kind: 'replace', providerId, candidate, base, next },
          { objectId: base.objectId, epoch: base.epoch, generation: base.generation },
        );
      const result = await input.store.session.compareAndSwap(
        accountKey(next.objectId),
        remote.version,
        accountBytes(next),
        signal,
      );
      if (result.kind !== 'written') throw new Error('SYNC_OAUTH_REPLACEMENT_CONFLICT');
      applyLocal(input, providerId, candidate, next, row, 'shared');
    });
  }

  async function detach(
    providerId: string,
    candidate: AccountWrite,
    signal: AbortSignal,
  ): Promise<'independent' | 'pending'> {
    return input.withProviderGate(providerId, async () => {
      const entity = entityFor(input.repo, input.binding, providerId);
      if (entity?.oauth === undefined || entity.oauth.mode === 'independent') return 'pending';
      const resolved = await validatedAdapter(input, providerId, candidate);
      if (resolved === undefined) return 'pending';
      const existing = findJournal(input, providerId, 'detach');
      if (existing !== undefined && !sameJson(existing.payload.candidate, candidate)) return 'pending';
      const remote = await readRemote(input.store, entity.objectId, signal);
      if (
        remote === null ||
        'unknown' in remote ||
        !compatibleRemote(remote.account, candidate, resolved) ||
        !readyOwnedRemote(entity.oauth, remote.account)
      )
        return 'pending';
      if (existing?.payload.base !== null && !sameRemote(existing?.payload.base ?? remote.account, remote.account)) {
        return 'pending';
      }
      const row =
        existing?.row ??
        writeJournal(
          input,
          {
            schema: 'oauth-sharing-v1',
            kind: 'detach',
            providerId,
            candidate,
            base: remote.account,
            next: null,
          },
          { objectId: remote.account.objectId, epoch: remote.account.epoch, generation: remote.account.generation },
        );
      setPending(input, providerId, 'detach-pending', true);
      if (!(await verifyDetach(resolved.adapter, remote.account.payload.credential, candidate, signal)))
        return 'pending';
      const durable = input.repo
        .oauthJournals(input.binding.id)
        .find((journal) => journal.operationId === row.operationId);
      const current = entityFor(input.repo, input.binding, providerId);
      if (
        durable === undefined ||
        !sameJson(durable.payload, row.payload) ||
        current?.objectId !== row.objectId ||
        current.oauth?.mode !== 'detach-pending' ||
        current.oauth.epoch !== row.epoch ||
        current.oauth.generation !== row.baseGeneration ||
        current.oauth.pluginVersion !== remote.account.pluginVersion ||
        current.oauth.formatVersion !== remote.account.formatVersion
      )
        return 'pending';
      applyLocal(input, providerId, candidate, remote.account, row, 'independent');
      return 'independent';
    });
  }

  function cancelDetach(providerId: string): void {
    const pending = findJournal(input, providerId, 'detach');
    if (pending === undefined) return;
    input.accounts.withAccountTransaction(() => {
      const entity = entityFor(input.repo, input.binding, providerId);
      if (
        entity?.objectId === pending.row.objectId &&
        entity.oauth?.mode === 'detach-pending' &&
        entity.oauth.epoch === pending.row.epoch &&
        entity.oauth.generation === pending.row.baseGeneration
      ) {
        input.repo.putEntity(input.binding.id, {
          ...entity,
          pendingReason: null,
          oauth: { ...entity.oauth, mode: 'shared' },
        });
      }
      finishJournal(input, pending.row);
    });
  }

  async function recover(signal: AbortSignal): Promise<void> {
    for (const row of input.repo.oauthJournals(input.binding.id)) {
      const payload = asJournalPayload(row.payload);
      if (payload === undefined) continue;
      if (payload.kind === 'share') await share(payload.providerId, signal);
      else if (payload.kind === 'replace') await replaceShared(payload.providerId, payload.candidate, signal);
      else await detach(payload.providerId, payload.candidate, signal);
    }
    for (const entity of input.repo.entities(input.binding.id)) {
      if (entity.kind === 'provider' && entity.oauth === undefined) await share(entity.logicalKey, signal);
    }
  }

  async function synchronizeLogin(providerId: string, candidate: AccountWrite, signal: AbortSignal): Promise<void> {
    const entity = entityFor(input.repo, input.binding, providerId);
    if (entity === undefined) return;
    if (entity.oauth?.mode === 'detach-pending') cancelDetach(providerId);
    if (entity.oauth === undefined || entity.oauth.mode === 'independent') {
      if ((await share(providerId, signal)) !== 'shared') throw new Error('SYNC_OAUTH_SHARE_PENDING');
      return;
    }
    await replaceShared(providerId, candidate, signal);
  }

  return { share, replaceShared, detach, cancelDetach, recover, synchronizeLogin };
}
