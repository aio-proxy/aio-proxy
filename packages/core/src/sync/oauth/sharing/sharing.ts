import type { OAuthAdapter } from '@aio-proxy/plugin-sdk';
import { SyncBackendError } from '@aio-proxy/plugin-sdk';

import type { AccountWrite, PluginRepository } from '../../../plugins/repository';
import { accountKey } from '../../protocol';
import type { SyncObjectStore } from '../../publication';
import type { LocalBinding, SyncRepository } from '../../repository';
import {
  accountBytes,
  entityFor,
  independentOwnership,
  payloadFor,
  readRemote,
  sharedOwnership,
  verifyDetach,
} from './detach';

export interface OAuthSharingService {
  share(providerId: string, signal: AbortSignal): Promise<'shared' | 'pending'>;
  replaceShared(providerId: string, candidate: AccountWrite, signal: AbortSignal): Promise<void>;
  detach(providerId: string, candidate: AccountWrite, signal: AbortSignal): Promise<'independent' | 'pending'>;
  cancelDetach(providerId: string): void;
}

export interface OAuthSharingServiceInput {
  readonly binding: LocalBinding;
  readonly repo: SyncRepository;
  readonly accounts: PluginRepository;
  readonly store: SyncObjectStore;
  resolveAdapter(providerId: string): { adapter: OAuthAdapter; pluginVersion: string };
  withProviderGate<T>(providerId: string, run: () => Promise<T>): Promise<T>;
}

function ownership(
  input: OAuthSharingServiceInput,
  providerId: string,
  value: ReturnType<typeof sharedOwnership>,
): void {
  const entity = entityFor(input.repo, input.binding, providerId);
  if (entity === undefined) throw new Error('SYNC_OAUTH_ENTITY_MISSING');
  input.repo.putEntity(input.binding.id, { ...entity, oauth: value });
}

function accountFor(input: OAuthSharingServiceInput, providerId: string): ReturnType<PluginRepository['readAccount']> {
  return input.accounts.readAccount(providerId);
}

function markPending(input: OAuthSharingServiceInput, providerId: string, reason: string, detach = false): void {
  const entity = entityFor(input.repo, input.binding, providerId);
  if (entity !== undefined)
    input.repo.putEntity(input.binding.id, {
      ...entity,
      pendingReason: reason,
      ...(detach && entity.oauth !== undefined ? { oauth: { ...entity.oauth, mode: 'detach-pending' as const } } : {}),
    });
}

function journal(
  input: OAuthSharingServiceInput,
  objectId: string,
  epoch: number,
  generation: number,
  payload: AccountWrite,
): string {
  const operationId = crypto.randomUUID();
  input.repo.writeOAuthJournal(input.binding.id, {
    operationId,
    objectId,
    epoch,
    baseGeneration: generation,
    phase: 'started',
    payload: payload as never,
  });
  return operationId;
}

function liveAccount(
  input: OAuthSharingServiceInput,
  providerId: string,
  candidate: AccountWrite,
  generation: number,
): import('../protocol').LiveAccount {
  const resolved = input.resolveAdapter(providerId);
  return {
    protocol: 1,
    objectId: entityFor(input.repo, input.binding, providerId)?.objectId ?? crypto.randomUUID(),
    epoch: 0,
    plugin: candidate.plugin,
    capability: candidate.capability,
    pluginVersion: resolved.pluginVersion,
    formatVersion: resolved.adapter.credentialSync?.formatVersion ?? 0,
    generation,
    phase: 'ready',
    payload: payloadFor(candidate),
    claim: null,
    lastCompletedOperationId: null,
  };
}

// eslint-disable-next-line max-lines-per-function
export function createOAuthSharingService(input: OAuthSharingServiceInput): OAuthSharingService {
  const pending = new Map<string, { candidate: AccountWrite; generation: number; operationId?: string }>();
  return {
    async share(providerId, signal) {
      return input.withProviderGate(providerId, async () => {
        const local = accountFor(input, providerId);
        const entity = entityFor(input.repo, input.binding, providerId);
        if (local === null || entity === undefined) return 'pending';
        const resolved = input.resolveAdapter(providerId);
        if (
          resolved.adapter.credentialSync?.formatVersion !== 1 ||
          (resolved.adapter.credentialSync.multiDevice?.evidenceId.length ?? 0) === 0
        ) {
          markPending(input, providerId, 'pending-plugin-update');
          return 'pending';
        }
        const candidate = {
          providerId,
          plugin: local.plugin,
          capability: local.capability,
          fingerprint: local.fingerprint,
          options: local.options,
          secrets: local.secrets,
          credential: local.credential,
          ...(local.label === undefined ? {} : { label: local.label }),
          ...(local.expiresAt === undefined ? {} : { expiresAt: local.expiresAt }),
          catalog: { kind: 'preserve' as const },
        } satisfies AccountWrite;
        const account = liveAccount(input, providerId, candidate, 0);
        const remote = await readRemote(input.store, account.objectId, signal);
        if (remote !== null && 'unknown' in remote) {
          markPending(input, providerId, 'upgrade-required');
          return 'pending';
        }
        if (remote !== null) {
          if (JSON.stringify(remote.account.payload) !== JSON.stringify(account.payload)) return 'pending';
          ownership(input, providerId, sharedOwnership(remote.account, local.revision));
          return 'shared';
        }
        const operationId = journal(input, account.objectId, 0, 0, candidate);
        let result;
        let confirmed = account;
        try {
          result = await input.store.session.compareAndSwap(
            accountKey(account.objectId),
            null,
            accountBytes(account),
            signal,
          );
        } catch (error) {
          if (!(error instanceof SyncBackendError) || error.code !== 'outcome-unknown') throw error;
          const observed = await readRemote(input.store, account.objectId, signal);
          if (
            observed === null ||
            'unknown' in observed ||
            observed.account.objectId !== account.objectId ||
            observed.account.epoch !== account.epoch ||
            observed.account.plugin !== account.plugin ||
            observed.account.capability !== account.capability ||
            observed.account.pluginVersion !== account.pluginVersion ||
            observed.account.formatVersion !== account.formatVersion ||
            observed.account.phase !== 'ready' ||
            JSON.stringify(observed.account.payload) !== JSON.stringify(account.payload)
          )
            return 'pending';
          confirmed = observed.account;
          result = { kind: 'written' as const, version: '', modifiedAt: 0 };
        }
        if (result.kind !== 'written') return 'pending';
        input.repo.writeOAuthJournal(input.binding.id, {
          operationId,
          objectId: account.objectId,
          epoch: confirmed.epoch,
          baseGeneration: confirmed.generation,
          phase: 'complete',
          payload: candidate as never,
        });
        input.repo.clearOAuthJournal(input.binding.id, operationId);
        ownership(input, providerId, sharedOwnership(confirmed, local.revision));
        return 'shared';
      });
    },

    async replaceShared(providerId, candidate, signal) {
      return input.withProviderGate(providerId, async () => {
        const entity = entityFor(input.repo, input.binding, providerId);
        const remote = entity === undefined ? null : await readRemote(input.store, entity.objectId, signal);
        if (remote === null || 'unknown' in remote) throw new Error('SYNC_OAUTH_ACCOUNT_MISSING');
        const resolved = input.resolveAdapter(providerId);
        if (
          resolved.adapter.credentialSync?.formatVersion !== 1 ||
          (resolved.adapter.credentialSync.multiDevice?.evidenceId.length ?? 0) === 0
        )
          throw new Error('SYNC_OAUTH_UPGRADE_REQUIRED');
        const next = {
          ...liveAccount(input, providerId, candidate, remote.account.generation + 1),
          objectId: remote.account.objectId,
          epoch: remote.account.epoch,
          plugin: remote.account.plugin,
          capability: remote.account.capability,
          pluginVersion: remote.account.pluginVersion,
          formatVersion: remote.account.formatVersion,
        };
        const result = await input.store.session.compareAndSwap(
          accountKey(next.objectId),
          remote.version,
          accountBytes(next),
          signal,
        );
        if (result.kind !== 'written') throw new Error('SYNC_OAUTH_REPLACEMENT_CONFLICT');
        const local = accountFor(input, providerId);
        if (local === null) throw new Error('SYNC_OAUTH_ACCOUNT_MISSING');
        input.accounts.withAccountTransaction(() => {
          const operation = input.accounts.stageAccountOperation({
            kind: 'update',
            targetDigest: `sync:${next.objectId}:${next.generation}`,
            expectedRuntimeRevision: local.runtimeRevision,
            account: { ...candidate, catalog: { kind: 'preserve' } },
          });
          input.accounts.completeAccountOperation(operation.operationId);
          const updated = input.accounts.readAccount(providerId);
          if (updated !== null) ownership(input, providerId, sharedOwnership(next, updated.revision));
        });
      });
    },

    async detach(providerId, candidate, signal) {
      const generation = (pending.get(providerId)?.generation ?? 0) + 1;
      pending.set(providerId, { candidate, generation });
      return input.withProviderGate(providerId, async () => {
        const entity = entityFor(input.repo, input.binding, providerId);
        const remote = entity === undefined ? null : await readRemote(input.store, entity.objectId, signal);
        if (remote === null || 'unknown' in remote) return 'pending';
        const token = pending.get(providerId);
        if (token === undefined) return 'pending';
        const operationId = journal(
          input,
          remote.account.objectId,
          remote.account.epoch,
          remote.account.generation,
          candidate,
        );
        pending.set(providerId, { ...token, operationId });
        markPending(input, providerId, 'detach-pending', true);
        const resolved = input.resolveAdapter(providerId);
        if (!(await verifyDetach(resolved.adapter, remote.account.payload.credential, candidate, signal))) {
          markPending(input, providerId, 'detach-pending', true);
          return 'pending';
        }
        if (pending.get(providerId)?.generation !== token.generation) return 'pending';
        const local = accountFor(input, providerId);
        if (local === null) return 'pending';
        input.accounts.withAccountTransaction(() => {
          const operation = input.accounts.stageAccountOperation({
            kind: 'update',
            targetDigest: `detach:${providerId}`,
            expectedRuntimeRevision: local.runtimeRevision,
            account: candidate,
          });
          input.accounts.completeAccountOperation(operation.operationId);
          const updated = input.accounts.readAccount(providerId);
          if (updated !== null) {
            const current = entityFor(input.repo, input.binding, providerId);
            if (current !== undefined)
              input.repo.putEntity(input.binding.id, {
                ...current,
                pendingReason: null,
                oauth: independentOwnership(remote.account, updated.revision),
              });
          }
        });
        input.repo.writeOAuthJournal(input.binding.id, {
          operationId,
          objectId: remote.account.objectId,
          epoch: remote.account.epoch,
          baseGeneration: remote.account.generation,
          phase: 'complete',
          payload: candidate as never,
        });
        input.repo.clearOAuthJournal(input.binding.id, operationId);
        pending.delete(providerId);
        return 'independent';
      });
    },

    cancelDetach(providerId) {
      const current = pending.get(providerId);
      if (current !== undefined) {
        const entity = entityFor(input.repo, input.binding, providerId);
        if (current.operationId !== undefined && entity?.oauth !== undefined) {
          input.repo.writeOAuthJournal(input.binding.id, {
            operationId: current.operationId,
            objectId: entity.objectId,
            epoch: entity.oauth.epoch,
            baseGeneration: entity.oauth.generation,
            phase: 'complete',
            payload: null,
          });
          input.repo.clearOAuthJournal(input.binding.id, current.operationId);
        }
        if (entity?.oauth?.mode === 'detach-pending')
          input.repo.putEntity(input.binding.id, {
            ...entity,
            pendingReason: null,
            oauth: { ...entity.oauth, mode: 'shared' },
          });
        pending.set(providerId, { ...current, generation: current.generation + 1, operationId: undefined });
      }
    },
  };
}
