import type { OAuthAdapter } from '@aio-proxy/plugin-sdk';
import { SyncBackendError } from '@aio-proxy/plugin-sdk';
import { isEqual } from 'es-toolkit/predicate';

import type { AccountWrite, PluginRepository, StoredAccount } from '../../../plugins/repository';
import { accountKey } from '../../protocol';
import type { SyncObjectStore } from '../../publication';
import type { LocalBinding, LocalEntity, SyncRepository } from '../../repository';
import { retainsSharedOAuth } from '../protocol';
import { accountBytes, entityFor, payloadFor, readRemote, verifyDetach } from './detach';
import { asJournalPayload } from './journal';
import { importRemoteAccount } from './receive';
import {
  abandonedOwnedRemote,
  accountWrite,
  applyLocal,
  compatibleRemote,
  findJournal,
  finishJournal,
  liveAccount,
  ownership,
  readyOwnedRemote,
  setPending,
  validatedAdapter,
  writeJournal,
} from './state';

export interface OAuthSharingService {
  share(providerId: string, signal: AbortSignal): Promise<'shared' | 'pending'>;
  /**
   * Imports a Provider's synchronized account on a device that has none yet. The caller resolves the
   * adapter from the discovered entity, because no local account exists to resolve it from.
   */
  receive(
    providerId: string,
    resolved: { readonly adapter: OAuthAdapter; readonly plugin: string; readonly pluginVersion: string },
    signal: AbortSignal,
  ): Promise<StoredAccount | null>;
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

// eslint-disable-next-line max-lines-per-function
export function createOAuthSharingService(input: OAuthSharingServiceInput): OAuthSharingService {
  /**
   * An excluded Provider is one the user declined to put in the cloud, so its credential must never
   * reach the backend — not through startup recovery, not through a later login. Ownership that
   * already exists is different: excluding a row locally does not retract the remote account, and a
   * share fenced by a journal row must still finish or its ownership is stranded.
   */
  function sharable(entity: LocalEntity, providerId: string): boolean {
    return (
      entity.mode === 'included' ||
      (entity.oauth !== undefined && entity.oauth.mode !== 'independent') ||
      findJournal(input, providerId, 'share') !== undefined
    );
  }

  async function share(providerId: string, signal: AbortSignal): Promise<'shared' | 'pending'> {
    return input.withProviderGate(providerId, async () => {
      const local = input.accounts.readAccount(providerId);
      const entity = entityFor(input.repo, input.binding, providerId);
      if (local === null || entity === undefined || input.repo.readBinding()?.id !== input.binding.id) return 'pending';
      if (!sharable(entity, providerId)) return 'pending';
      const candidate = accountWrite(local);
      const resolved = await validatedAdapter(input, providerId, candidate);
      if (resolved === undefined) {
        setPending(input, providerId, 'pending-plugin-update');
        return 'pending';
      }
      if (
        input.repo
          .bindings()
          .some(
            (binding) =>
              binding.id !== input.binding.id &&
              input.repo
                .entities(binding.id)
                .some(
                  (old) =>
                    old.kind === 'provider' &&
                    old.logicalKey === providerId &&
                    retainsSharedOAuth(old, input.repo.oauthJournals(binding.id)),
                ),
          )
      ) {
        setPending(input, providerId, 'detach-pending');
        return 'pending';
      }
      const pending = findJournal(input, providerId, 'share');
      if (entity.oauth?.mode === 'shared' || entity.oauth?.mode === 'detach-pending') {
        if (
          entity.oauth.pluginVersion !== resolved.pluginVersion ||
          entity.oauth.formatVersion !== resolved.adapter.credentialSync?.formatVersion ||
          entity.oauth.multiDeviceEvidenceId !== resolved.adapter.credentialSync?.multiDevice?.evidenceId
        ) {
          setPending(input, providerId, 'pending-plugin-update');
          return 'pending';
        }
        return entity.oauth.mode === 'shared' ? 'shared' : 'pending';
      }
      // Read before minting so a tombstone left by a restore or a purged-then-restored entity is
      // superseded at its own epoch. Minting at epoch 0 and compare-and-swapping against an absent
      // key can never match a present tombstone, which stalls sharing for good. Reading ahead of the
      // journal is safe where a write would not be: a lost read reply leaves nothing behind.
      const remote = await readRemote(input.store, entity.objectId, signal);
      const tombstone = remote !== null && 'deleted' in remote ? remote : undefined;
      const next =
        pending?.payload.next ?? liveAccount(entity.objectId, candidate, resolved, 0, tombstone?.deleted.epoch ?? 0);
      if (
        next === null ||
        !isEqual(pending?.payload.candidate ?? candidate, candidate) ||
        !compatibleRemote(next, candidate, resolved)
      )
        return 'pending';
      // Fence ownership before the first remote write, including conflicts and lost replies.
      const row =
        pending?.row ??
        writeJournal(
          input,
          { schema: 'oauth-sharing-v1', kind: 'share', providerId, candidate, base: null, next },
          { objectId: next.objectId, epoch: next.epoch, generation: 0 },
        );
      input.repo.putEntity(input.binding.id, {
        ...entity,
        pendingReason: 'share-pending',
        oauth: ownership(next, local.revision, 'share-pending'),
      });
      if (remote !== null && !('deleted' in remote)) {
        if (
          'unknown' in remote ||
          !compatibleRemote(remote.account, candidate, resolved) ||
          !isEqual(remote.account, next)
        ) {
          setPending(input, providerId, 'pending-plugin-update');
          return 'pending';
        }
        applyLocal(input, providerId, candidate, remote.account, row, 'shared');
        return 'shared';
      }
      if (pending !== undefined) return 'pending';
      try {
        const result = await input.store.session.compareAndSwap(
          accountKey(next.objectId),
          tombstone?.version ?? null,
          accountBytes(next),
          signal,
        );
        if (result.kind !== 'written') return 'pending';
      } catch (error) {
        if (!(error instanceof SyncBackendError) || error.code !== 'outcome-unknown') throw error;
        const observed = await readRemote(input.store, next.objectId, signal);
        if (observed === null || 'unknown' in observed || 'deleted' in observed || !isEqual(observed.account, next))
          return 'pending';
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
      if (pending !== undefined && !isEqual(pending.payload.candidate, candidate)) {
        throw new Error('SYNC_OAUTH_REPLACEMENT_PENDING');
      }
      const remote = await readRemote(input.store, entity.objectId, signal);
      if (remote === null || 'unknown' in remote || 'deleted' in remote) throw new Error('SYNC_OAUTH_ACCOUNT_MISSING');
      if (!compatibleRemote(remote.account, candidate, resolved)) throw new Error('SYNC_OAUTH_UPGRADE_REQUIRED');
      // A fresh authorization is the documented recovery from an abandoned refresh, so it takes
      // over the stale claim on a new epoch instead of waiting for a `ready` that never comes.
      const abandoned = abandonedOwnedRemote(entity.oauth, remote.account);
      if (pending === undefined && !abandoned && !readyOwnedRemote(entity.oauth, remote.account)) {
        throw new Error('SYNC_OAUTH_REPLACEMENT_PENDING');
      }
      if (pending !== undefined) {
        const expected = pending.payload.next;
        if (expected === null) throw new Error('SYNC_OAUTH_REPLACEMENT_PENDING');
        if (isEqual(remote.account, expected)) {
          applyLocal(input, providerId, candidate, expected, pending.row, 'shared');
          return;
        }
        if (pending.payload.base === null || !isEqual(remote.account, pending.payload.base)) {
          throw new Error('SYNC_OAUTH_REPLACEMENT_CONFLICT');
        }
      }
      const base = pending?.payload.base ?? remote.account;
      const next =
        pending?.payload.next ??
        liveAccount(
          remote.account.objectId,
          candidate,
          resolved,
          remote.account.generation + 1,
          abandoned ? remote.account.epoch + 1 : remote.account.epoch,
        );
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
      const journaled = findJournal(input, providerId, 'detach');
      // A pending row means that candidate already failed the independence check, so re-verifying it
      // can only fail again. Retire it and let the newer authorization be the candidate instead.
      const stale = journaled !== undefined && !isEqual(journaled.payload.candidate, candidate);
      if (stale) finishJournal(input, journaled.row);
      const existing = stale ? undefined : journaled;
      const remote = await readRemote(input.store, entity.objectId, signal);
      if (
        remote === null ||
        'unknown' in remote ||
        'deleted' in remote ||
        !compatibleRemote(remote.account, candidate, resolved) ||
        // Detaching reads the shared credential but never republishes it, so an abandoned refresh
        // is no reason to strand this device on an account it is trying to stop following.
        !(readyOwnedRemote(entity.oauth, remote.account) || abandonedOwnedRemote(entity.oauth, remote.account))
      )
        return 'pending';
      if (existing?.payload.base !== null && !isEqual(existing?.payload.base ?? remote.account, remote.account)) {
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
        !isEqual(durable.payload, row.payload) ||
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
    input.repo.writeOAuthJournal(input.binding.id, pending.row);
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
      if (entity.kind === 'provider' && entity.oauth?.mode !== 'independent') await share(entity.logicalKey, signal);
    }
  }

  async function synchronizeLogin(providerId: string, candidate: AccountWrite, signal: AbortSignal): Promise<void> {
    const entity = entityFor(input.repo, input.binding, providerId);
    if (entity === undefined) {
      if (
        input.repo
          .bindings()
          .some((binding) =>
            input.repo
              .entities(binding.id)
              .some(
                (old) =>
                  old.kind === 'provider' &&
                  old.logicalKey === providerId &&
                  old.oauth !== undefined &&
                  old.oauth.mode !== 'independent',
              ),
          )
      )
        throw new Error('SYNC_OAUTH_DETACH_PENDING');
      return;
    }
    // A pending detach is waiting for an independently usable authorization, and this login is how
    // the user produces one. Publishing it as the shared credential would make the shared and
    // candidate credentials identical, so canDetach could never approve the detachment again.
    if (entity.oauth?.mode === 'detach-pending') return;
    // Login on an excluded Provider is a purely local event; blocking it on a share that must not
    // happen would make the Provider unusable.
    if (!sharable(entity, providerId)) return;
    if (entity.oauth === undefined || entity.oauth.mode === 'independent' || entity.oauth.mode === 'share-pending') {
      if ((await share(providerId, signal)) !== 'shared') throw new Error('SYNC_OAUTH_SHARE_PENDING');
      return;
    }
    const resolved = await validatedAdapter(input, providerId, candidate);
    if (resolved === undefined) throw new Error('SYNC_OAUTH_UPGRADE_REQUIRED');
    const local = input.accounts.readAccount(providerId);
    if (entity.oauth.localRevision === local?.revision && findJournal(input, providerId, 'replace') === undefined) {
      const remote = await readRemote(input.store, entity.objectId, signal);
      if (
        remote !== null &&
        !('unknown' in remote) &&
        !('deleted' in remote) &&
        compatibleRemote(remote.account, candidate, resolved) &&
        readyOwnedRemote(entity.oauth, remote.account) &&
        isEqual(remote.account.payload, payloadFor(candidate))
      )
        return;
    }
    await replaceShared(providerId, candidate, signal);
  }

  return {
    share,
    receive: (providerId, resolved, signal) => importRemoteAccount(input, providerId, resolved, signal),
    replaceShared,
    detach,
    cancelDetach,
    recover,
    synchronizeLogin,
  };
}
