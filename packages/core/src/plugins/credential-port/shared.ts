import type { CredentialPort, CredentialSnapshot, ZodType } from '@aio-proxy/plugin-sdk';
import { isEqual } from 'es-toolkit/predicate';

import type { SharedOAuthCoordinator } from '../../sync/oauth/coordinator';
import type { LiveAccount, OAuthOwnership } from '../../sync/oauth/protocol';
import { SyncOAuthError } from '../../sync/oauth/protocol';
import type { LocalBinding, LocalEntity, SyncRepository } from '../../sync/repository';
import type { PluginRepository, StoredAccount } from '../repository';
import { parsePluginSchema } from '../schema';
import {
  CredentialAccountMissingError,
  CredentialValidationError,
  withRefreshExchangeDeadline,
} from './credential-port';

export type SharedCredentialCallbacks = {
  readonly onDiagnosticChanged?: () => void;
  readonly onCredentialChanged?: () => void;
};

type SharedCredentialInput<C> = SharedCredentialCallbacks & {
  readonly providerId: string;
  readonly objectId: string;
  readonly binding: LocalBinding;
  readonly coordinator: SharedOAuthCoordinator;
  readonly repo: SyncRepository;
  readonly accounts: PluginRepository;
  readonly schema: ZodType<C>;
};

function entityFor(input: Pick<SharedCredentialInput<unknown>, 'binding' | 'repo' | 'objectId'>): LocalEntity {
  const entity = input.repo.entities(input.binding.id).find((candidate) => candidate.objectId === input.objectId);
  if (entity === undefined || entity.oauth === undefined || entity.oauth.mode !== 'shared') {
    throw new SyncOAuthError('detach-pending', 'The shared OAuth ownership is unresolved');
  }
  return entity;
}

function validateOwnership(
  input: SharedCredentialInput<unknown>,
  entity: LocalEntity,
  account: StoredAccount,
): OAuthOwnership {
  const ownership = entity.oauth;
  if (ownership === undefined || ownership.mode !== 'shared') {
    throw new SyncOAuthError('detach-pending', 'The shared OAuth ownership is unresolved');
  }
  if (account.revision !== ownership.localRevision) {
    throw new SyncOAuthError('detach-pending', 'The local shared OAuth snapshot is out of date');
  }
  return ownership;
}

async function validated<C>(schema: ZodType<C>, value: unknown): Promise<C> {
  const result = await parsePluginSchema(schema, value);
  if (!result.ok) throw new CredentialValidationError(result.issues);
  return result.value;
}

function applyCallbacks<C>(input: SharedCredentialInput<C>, hadRefreshDiagnostic: boolean): void {
  if (hadRefreshDiagnostic) input.onDiagnosticChanged?.();
  input.onCredentialChanged?.();
}

function needsImport(ownership: OAuthOwnership, local: StoredAccount, remote: LiveAccount): boolean {
  return (
    ownership.epoch !== remote.epoch ||
    ownership.generation !== remote.generation ||
    ownership.pluginVersion !== remote.pluginVersion ||
    ownership.formatVersion !== remote.formatVersion ||
    local.plugin !== remote.plugin ||
    local.capability !== remote.capability ||
    !isEqual(local.fingerprint, remote.payload.fingerprint) ||
    !isEqual(local.options, remote.payload.options) ||
    !isEqual(local.secrets, remote.payload.secrets) ||
    !isEqual(local.credential, remote.payload.credential) ||
    !isEqual(local.label, remote.payload.label) ||
    !isEqual(local.expiresAt, remote.payload.expiresAt)
  );
}

export function applySyncedAccount(input: {
  readonly binding: LocalBinding;
  readonly account: LiveAccount;
  readonly providerId: string;
  readonly repo: SyncRepository;
  readonly accounts: PluginRepository;
}): StoredAccount {
  return input.accounts.withAccountTransaction(() => {
    const current = input.accounts.readAccount(input.providerId);
    if (current === null) throw new CredentialAccountMissingError();
    if (current.plugin !== input.account.plugin || current.capability !== input.account.capability) {
      throw new CredentialAccountMissingError();
    }
    const pending = input.accounts.stageAccountOperation({
      kind: 'update',
      targetDigest: `sync:${input.account.objectId}:${input.account.epoch}:${input.account.generation}`,
      expectedRuntimeRevision: current.runtimeRevision,
      account: {
        providerId: input.providerId,
        plugin: input.account.plugin,
        capability: input.account.capability,
        fingerprint: input.account.payload.fingerprint,
        options: input.account.payload.options,
        secrets: input.account.payload.secrets,
        credential: input.account.payload.credential,
        ...(input.account.payload.label === undefined ? {} : { label: input.account.payload.label }),
        ...(input.account.payload.expiresAt === undefined ? {} : { expiresAt: input.account.payload.expiresAt }),
        catalog: { kind: 'preserve' },
      },
    });
    input.accounts.completeAccountOperation(pending.operationId);
    const entity = input.repo
      .entities(input.binding.id)
      .find((candidate) => candidate.objectId === input.account.objectId);
    if (entity === undefined) throw new SyncOAuthError('detach-pending', 'The shared OAuth entity is missing locally');
    input.repo.putEntity(input.binding.id, {
      ...entity,
      oauth: {
        multiDeviceEvidenceId: input.account.multiDeviceEvidenceId,
        mode: entity.oauth?.mode === 'detach-pending' ? 'detach-pending' : 'shared',
        epoch: input.account.epoch,
        generation: input.account.generation,
        localRevision: pending.appliedRevision,
        pluginVersion: input.account.pluginVersion,
        formatVersion: input.account.formatVersion,
      },
    });
    const updated = input.accounts.readAccount(input.providerId);
    if (updated === null) throw new CredentialAccountMissingError();
    return updated;
  });
}

export function createSharedCredentialPort<C>(input: SharedCredentialInput<C>): CredentialPort<C> {
  // A read is on the model request path and must never wait on the sync backend: an offline or
  // stalled CloudKit would fail requests this device can already serve. Every local ownership
  // check still runs, so a credential this device no longer owns is still refused. A credential
  // another device rotated or invalidated is caught when the local one expires and the runtime
  // calls `refresh`, which still coordinates remotely.
  const readLocal = async (): Promise<CredentialSnapshot<C>> => {
    const local = input.accounts.readAccount(input.providerId);
    if (local === null) throw new CredentialAccountMissingError();
    validateOwnership(input, entityFor(input), local);
    return { value: await validated(input.schema, local.credential), revision: local.revision };
  };

  const readCoordinated = async (): Promise<CredentialSnapshot<C>> => {
    const local = input.accounts.readAccount(input.providerId);
    if (local === null) throw new CredentialAccountMissingError();
    const entity = entityFor(input);
    const ownership = validateOwnership(input, entity, local);
    const recovered = await input.coordinator.recover(input.objectId, new AbortController().signal);
    if (recovered === null) throw new CredentialAccountMissingError();
    if (recovered.phase !== 'ready') {
      if (recovered.phase === 'login-required') {
        throw new SyncOAuthError('login-required', 'The shared OAuth account requires login');
      }
      throw new SyncOAuthError('refresh-deferred', 'The shared OAuth account is not ready');
    }
    if (recovered.plugin !== local.plugin || recovered.capability !== local.capability)
      throw new CredentialAccountMissingError();
    if (
      recovered.objectId !== entity.objectId ||
      recovered.pluginVersion !== ownership.pluginVersion ||
      recovered.formatVersion !== ownership.formatVersion ||
      recovered.multiDeviceEvidenceId !== ownership.multiDeviceEvidenceId ||
      recovered.claim !== null
    )
      throw new SyncOAuthError('upgrade-required', 'The shared OAuth account is incompatible');
    const value = await validated(input.schema, recovered.payload.credential);
    if (needsImport(ownership, local, recovered)) {
      const hadRefreshDiagnostic = input.accounts
        .readDiagnostics(input.providerId)
        .some((diagnostic) => diagnostic.code === 'CREDENTIAL_REFRESH_FAILED');
      const applied = applySyncedAccount({
        binding: input.binding,
        account: recovered,
        providerId: input.providerId,
        repo: input.repo,
        accounts: input.accounts,
      });
      applyCallbacks(input, hadRefreshDiagnostic);
      return { value, revision: applied.revision };
    }
    return { value, revision: local.revision };
  };

  return {
    read: readLocal,
    async refresh(expectedRevision, exchange) {
      const current = await readCoordinated();
      if (current.revision !== expectedRevision) return { status: 'superseded', snapshot: current };
      const local = input.accounts.readAccount(input.providerId);
      if (local === null) throw new CredentialAccountMissingError();
      const entity = entityFor(input);
      const ownership = validateOwnership(input, entity, local);
      const result = await input.coordinator.refresh<C>(
        {
          objectId: input.objectId,
          epoch: ownership.epoch,
          generation: ownership.generation,
          // Bound only the adapter exchange, never the coordinator signal: a hung refresh has to
          // fail fast *and* leave the coordinator able to fence its claim as `uncertain`.
          exchange: (value, signal) =>
            withRefreshExchangeDeadline((deadline) =>
              exchange({ value, revision: expectedRevision }, AbortSignal.any([signal, deadline])),
            ),
          validate: (value) => validated(input.schema, value),
        },
        new AbortController().signal,
      );
      const value = await validated(input.schema, result.value);
      const hadRefreshDiagnostic = input.accounts
        .readDiagnostics(input.providerId)
        .some((diagnostic) => diagnostic.code === 'CREDENTIAL_REFRESH_FAILED');
      const applied = applySyncedAccount({
        binding: input.binding,
        account: result.account,
        providerId: input.providerId,
        repo: input.repo,
        accounts: input.accounts,
      });
      applyCallbacks(input, hadRefreshDiagnostic);
      if (result.account.lastCompletedOperationId !== null) {
        try {
          input.coordinator.confirm(input.objectId, result.account.lastCompletedOperationId);
        } catch {
          // The local import is durable. A later recovery pass can clear a stale journal.
        }
      }
      return {
        status: result.status,
        snapshot: { value, revision: applied.revision },
      };
    },
  };
}
