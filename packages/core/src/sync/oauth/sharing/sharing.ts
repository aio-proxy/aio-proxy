import type { OAuthAdapter } from '@aio-proxy/plugin-sdk';

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

export function createOAuthSharingService(input: OAuthSharingServiceInput): OAuthSharingService {
  const pending = new Map<string, AccountWrite>();
  return {
    async share(providerId, signal) {
      return input.withProviderGate(providerId, async () => {
        const local = accountFor(input, providerId);
        const entity = entityFor(input.repo, input.binding, providerId);
        if (local === null || entity === undefined) return 'pending';
        const resolved = input.resolveAdapter(providerId);
        if (resolved.adapter.credentialSync?.formatVersion !== 1) return 'pending';
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
        if (remote !== null) {
          if (JSON.stringify(remote.account.payload) !== JSON.stringify(account.payload)) return 'pending';
          ownership(input, providerId, sharedOwnership(remote.account, local.revision));
          return 'shared';
        }
        const result = await input.store.session.compareAndSwap(
          accountKey(account.objectId),
          null,
          accountBytes(account),
          signal,
        );
        if (result.kind !== 'written') return 'pending';
        ownership(input, providerId, sharedOwnership(account, local.revision));
        return 'shared';
      });
    },

    async replaceShared(providerId, candidate, signal) {
      return input.withProviderGate(providerId, async () => {
        const entity = entityFor(input.repo, input.binding, providerId);
        const remote = entity === undefined ? null : await readRemote(input.store, entity.objectId, signal);
        if (remote === null) throw new Error('SYNC_OAUTH_ACCOUNT_MISSING');
        const next = {
          ...liveAccount(input, providerId, candidate, remote.account.generation + 1),
          objectId: remote.account.objectId,
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
      pending.set(providerId, candidate);
      return input.withProviderGate(providerId, async () => {
        const entity = entityFor(input.repo, input.binding, providerId);
        const remote = entity === undefined ? null : await readRemote(input.store, entity.objectId, signal);
        if (remote === null) return 'pending';
        const resolved = input.resolveAdapter(providerId);
        if (!(await verifyDetach(resolved.adapter, remote.account.payload.credential, candidate, signal)))
          return 'pending';
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
                oauth: independentOwnership(remote.account, updated.revision),
              });
          }
        });
        pending.delete(providerId);
        return 'independent';
      });
    },

    cancelDetach(providerId) {
      pending.delete(providerId);
    },
  };
}
