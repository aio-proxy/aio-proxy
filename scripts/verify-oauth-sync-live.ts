import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { openDb } from '../packages/core/src/db';
import {
  accountKey,
  createPluginRegistryHost,
  createPluginRepository,
  createSharedOAuthCoordinator,
  createSyncObjectStore,
  createSyncRepository,
  encode,
  type LocalBinding,
  type SyncRepository,
  type LiveAccount,
  type SharedOAuthCoordinator,
} from '../packages/core/src/index';
import type { OAuthSyncEvidence } from '../packages/core/src/sync/oauth/adapter-conformance';
import type { OAuthAdapter, RuntimeFetch, SyncBackendDefinition, SyncSession } from '../packages/plugin-sdk/src';
import { BackendSetupError, loadSyncBackendDescriptor } from './verify-oauth-sync-backend';
import { copiedAccount, discover, readRemote } from './verify-oauth-sync-live-ports';

export type LiveFailureCode =
  | 'setup-sync-binding-required'
  | 'setup-backend-required'
  | 'setup-backend-unavailable'
  | 'setup-source-account-invalid'
  | 'setup-remote-object-missing'
  | 'setup-remote-object-invalid'
  | 'assertion-copied-use-failed'
  | 'assertion-rotation-failed'
  | 'assertion-recovery-failed'
  | 'assertion-device-binding-failed'
  | 'assertion-login-effects-failed'
  | 'assertion-detach-failed';
export type LiveRunInput = {
  readonly home: string;
  readonly providerId: string;
  readonly remoteObjectId: string;
  readonly plugin: string;
  readonly pluginVersion: string;
  readonly adapter: OAuthAdapter;
};
export type LiveRunResult = {
  readonly evidence: OAuthSyncEvidence;
  readonly failureCode?: LiveFailureCode;
  readonly details: {
    readonly credentialRead: boolean;
    readonly isolatedConfigurations: number;
    readonly backendConnected: boolean;
    readonly remoteObjectObserved: boolean;
  };
};

class BlockedError extends Error {
  constructor(readonly code: LiveFailureCode) {
    super(code);
  }
}

type AssertionResult = 'pass' | 'fail' | 'blocked';

export function matchesOAuthAdapter(
  account: Readonly<{ plugin: string; capability: string }>,
  plugin: string,
  capability: string,
): boolean {
  return account.plugin === plugin && account.capability === capability;
}

function canonicalPath(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(path);
    suffix.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  return join(realpathSync(current), ...suffix);
}

function isWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

export function isProtectedOAuthSyncHome(home: string, productionHomes: readonly string[]): boolean {
  const canonicalHome = canonicalPath(home);
  return productionHomes.some((productionHome) => isWithin(canonicalHome, canonicalPath(productionHome)));
}

function isInfrastructureFailure(reason: unknown): boolean {
  return reason instanceof Error && (reason.name === 'SyncBackendError' || reason.name === 'AbortError');
}

export function classifyRotationResults(results: readonly PromiseSettledResult<unknown>[]): AssertionResult {
  if (results.length === 0) return 'blocked';
  if (results.every((result) => result.status === 'fulfilled')) return 'pass';
  if (results.every((result) => result.status === 'rejected' && isInfrastructureFailure(result.reason)))
    return 'blocked';
  return 'fail';
}

export type InterruptedRefreshObservation = {
  readonly result: 'fulfilled' | 'rejected';
  readonly exchangeCompleted: boolean;
  readonly uncertainStateObserved: boolean;
  readonly recovered: boolean;
};

export function classifyInterruptedRefresh(observation: InterruptedRefreshObservation): AssertionResult {
  if (!observation.exchangeCompleted) return 'blocked';
  if (observation.result === 'fulfilled') return 'fail';
  if (!observation.uncertainStateObserved) return 'fail';
  return observation.recovered ? 'pass' : 'fail';
}

function binding(source: LocalBinding, deviceId: string): LocalBinding {
  return {
    ...source,
    id: `oauth-sync-live-${deviceId}`,
    deviceId,
    sessionGeneration: source.sessionGeneration + 1,
  };
}

function copyAccount(
  repository: ReturnType<typeof createPluginRepository>,
  account: LiveAccount,
  providerId: string,
): void {
  const operation = repository.stageAccountOperation({
    kind: 'create',
    targetDigest: `oauth-sync-live-${account.objectId}`,
    account: {
      providerId,
      plugin: account.plugin,
      capability: account.capability,
      fingerprint: account.payload.fingerprint,
      options: account.payload.options,
      secrets: account.payload.secrets,
      credential: account.payload.credential,
      ...(account.payload.label === undefined ? {} : { label: account.payload.label }),
      ...(account.payload.expiresAt === undefined ? {} : { expiresAt: account.payload.expiresAt }),
      catalog: {
        kind: 'missing',
        diagnostic: {
          code: 'CATALOG_UNAVAILABLE',
          summary: 'OAuth live conformance does not copy model catalogs',
          retryable: false,
          occurredAt: new Date().toISOString(),
        },
      },
    },
  });
  repository.completeAccountOperation(operation.operationId);
}

function putEntity(repo: SyncRepository, local: LocalBinding, account: LiveAccount, providerId: string): void {
  repo.putEntity(local.id, {
    objectId: account.objectId,
    logicalKey: providerId,
    kind: 'provider',
    mode: 'included',
    epoch: account.epoch,
    desired: null,
    baseline: null,
    overrides: [],
    pendingReason: null,
    oauth: {
      mode: 'shared',
      epoch: account.epoch,
      generation: account.generation,
      localRevision: 1,
      pluginVersion: account.pluginVersion,
      formatVersion: account.formatVersion,
      ...(account.multiDeviceEvidenceId === undefined ? {} : { multiDeviceEvidenceId: account.multiDeviceEvidenceId }),
    },
  });
}

function coordinator(repo: SyncRepository, session: SyncSession, local: LocalBinding): SharedOAuthCoordinator {
  return createSharedOAuthCoordinator({
    binding: local,
    store: createSyncObjectStore(session),
    repo,
  });
}

// eslint-disable-next-line max-lines-per-function -- the live runner keeps setup, backend execution, and cleanup in one fenced lifecycle.
export async function runOAuthSyncLive(input: LiveRunInput): Promise<LiveRunResult> {
  let evidence: OAuthSyncEvidence = {
    plugin: input.plugin,
    pluginVersion: input.pluginVersion,
    capability: input.adapter.id,
    formatVersion: input.adapter.credentialSync?.formatVersion ?? 0,
    testedAt: new Date().toISOString(),
    upstream: process.env['OAUTH_SYNC_UPSTREAM'] ?? 'unconfigured',
    copiedUse: 'blocked',
    rotation: input.adapter.refreshCredential === undefined ? 'not-applicable' : 'blocked',
    uncertainRecovery: 'blocked',
    deviceBinding: 'blocked',
    loginEffects: 'blocked',
    independentDetach: 'blocked',
  };
  let failureCode: LiveFailureCode | undefined;
  let credentialRead = false,
    isolatedConfigurations = 0,
    backendConnected = false,
    remoteObjectObserved = false;
  const homes: string[] = [],
    databases: ReturnType<typeof openDb>[] = [],
    sessions: SyncSession[] = [];
  const mark = async (code: LiveFailureCode, run: () => Promise<void>): Promise<'pass' | 'fail'> => {
    try {
      await run();
      return 'pass';
    } catch {
      failureCode ??= code;
      return 'fail';
    }
  };
  try {
    const sourceDb = openDb({ home: input.home, readonly: true });
    try {
      const accountRepo = createPluginRepository(sourceDb.sqlite);
      const syncRepo = createSyncRepository(sourceDb.sqlite);
      const source = accountRepo.readAccount(input.providerId);
      const sourceBinding = syncRepo.readBinding();
      if (source === null || sourceBinding === null) throw new BlockedError('setup-sync-binding-required');
      if (!matchesOAuthAdapter(source, input.plugin, input.adapter.id))
        throw new BlockedError('setup-source-account-invalid');
      input.adapter.credentials.parse(source.credential);
      credentialRead = true;
      const descriptor = await loadSyncBackendDescriptor(sourceBinding.plugin);
      const host = createPluginRegistryHost();
      const staged = host.stage(sourceBinding.plugin);
      await descriptor.setup(staged.api, undefined);
      staged.seal();
      staged.commit();
      const backend = host.registry.resolveSync(sourceBinding.plugin, sourceBinding.capability) as
        | SyncBackendDefinition<unknown>
        | undefined;
      if (backend === undefined) throw new BlockedError('setup-backend-unavailable');
      const controller = new AbortController();
      try {
        for (const device of ['a', 'b']) {
          const dir = mkdtempSync(join(resolve(input.home, '..'), `aio-proxy-oauth-sync-${device}-`));
          homes.push(dir);
          databases.push(openDb({ home: dir }));
        }
        for (let index = 0; index < 2; index++)
          sessions.push(
            await backend.connect(sourceBinding.options, {
              signal: controller.signal,
              dataDirectory: join(homes[index]!, '.sync', sourceBinding.id),
            }),
          );
        backendConnected = true;
        const remote = await readRemote(sessions[0]!, input.remoteObjectId, controller.signal);
        if (remote === null) throw new BlockedError('setup-remote-object-missing');
        if (!matchesOAuthAdapter(remote.account, input.plugin, input.adapter.id))
          throw new BlockedError('setup-remote-object-invalid');
        input.adapter.credentials.parse(remote.account.payload.credential);
        remoteObjectObserved = true;
        const locals = [binding(sourceBinding, 'a'), binding(sourceBinding, 'b')];
        const accountRepositories = databases.map((database) => createPluginRepository(database.sqlite));
        const repositories = databases.map((database, index) => {
          const repo = createSyncRepository(database.sqlite);
          repo.writeBinding(locals[index]!);
          copyAccount(accountRepositories[index]!, remote.account, input.providerId);
          putEntity(repo, locals[index]!, remote.account, input.providerId);
          isolatedConfigurations++;
          return repo;
        });
        const copiedAccounts = accountRepositories.map((repository) =>
          copiedAccount(
            remote.account,
            repository.readAccount(input.providerId)!.credential as LiveAccount['payload']['credential'],
          ),
        );
        evidence = {
          ...evidence,
          copiedUse: await mark('assertion-copied-use-failed', async () => {
            await Promise.all(copiedAccounts.map((account) => discover(input.adapter, account, controller.signal)));
          }),
          // The adapter context has no device identity or provider-specific portability hook, so
          // copied use cannot be promoted to device-binding evidence.
          deviceBinding: 'blocked',
        };
        if (input.adapter.refreshCredential !== undefined) {
          const exchange = (value: unknown, signal: AbortSignal) =>
            input.adapter.refreshCredential!({
              credential: value,
              options: remote.account.payload.options,
              signal,
              fetch: globalThis.fetch as RuntimeFetch,
            });
          const initial = await readRemote(sessions[0]!, input.remoteObjectId, controller.signal);
          if (initial === null) throw new BlockedError('setup-remote-object-missing');
          const expired = {
            ...initial.account,
            payload: { ...initial.account.payload, expiresAt: Date.now() - 1 },
          };
          if (
            (
              await sessions[0]!.compareAndSwap(
                accountKey(input.remoteObjectId),
                initial.version,
                encode(expired),
                controller.signal,
              )
            ).kind !== 'written'
          )
            throw new BlockedError('setup-remote-object-missing');
          const refreshInput = (account: LiveAccount) => ({
            objectId: input.remoteObjectId,
            epoch: account.epoch,
            generation: account.generation,
            exchange,
            validate: async (value: unknown) => input.adapter.credentials.parse(value),
          });
          const results = await Promise.allSettled([
            coordinator(repositories[0]!, sessions[0]!, locals[0]!).refresh(
              refreshInput(initial.account),
              controller.signal,
            ),
            coordinator(repositories[1]!, sessions[1]!, locals[1]!).refresh(
              refreshInput(initial.account),
              controller.signal,
            ),
          ]);
          const rotation = classifyRotationResults(results);
          evidence = { ...evidence, rotation };
          if (rotation === 'fail') failureCode ??= 'assertion-rotation-failed';
          const current = await readRemote(sessions[0]!, input.remoteObjectId, controller.signal);
          if (current === null) throw new BlockedError('setup-remote-object-missing');
          const caller = new AbortController();
          let exchangeCompleted = false;
          const interruptedResults = await Promise.allSettled([
            coordinator(repositories[0]!, sessions[0]!, locals[0]!).refresh(
              {
                ...refreshInput(current.account),
                exchange: async (value, signal) => {
                  const result = await exchange(value, signal);
                  exchangeCompleted = true;
                  caller.abort();
                  return result;
                },
              },
              caller.signal,
            ),
          ]);
          const interruptedResult = interruptedResults[0];
          const interruptedRemote = await readRemote(sessions[0]!, input.remoteObjectId, controller.signal);
          const uncertainStateObserved =
            interruptedRemote?.account.phase === 'uncertain' ||
            interruptedRemote?.account.phase === 'refreshing' ||
            repositories[0]!.oauthJournals(locals[0]!.id).some((journal) => journal.phase !== 'complete');
          let recovered = false;
          if (interruptedResult?.status === 'rejected' && uncertainStateObserved) {
            const recoveredAccount = await coordinator(repositories[0]!, sessions[0]!, locals[0]!)
              .recover(input.remoteObjectId, controller.signal)
              .catch(() => null);
            recovered = recoveredAccount?.phase === 'ready';
          }
          evidence = {
            ...evidence,
            uncertainRecovery: classifyInterruptedRefresh({
              result: interruptedResult?.status ?? 'rejected',
              exchangeCompleted,
              uncertainStateObserved,
              recovered,
            }),
          };
          if (evidence.uncertainRecovery === 'fail') failureCode ??= 'assertion-recovery-failed';
        }
        const after = await readRemote(sessions[0]!, input.remoteObjectId, controller.signal);
        if (after === null) throw new BlockedError('setup-remote-object-missing');
        evidence = {
          ...evidence,
          // The adapter contract has no independent candidate authorization or upstream revocation hook.
          independentDetach: 'blocked',
          loginEffects: 'blocked',
        };
      } finally {
        controller.abort();
      }
    } finally {
      sourceDb.close();
    }
  } catch (error) {
    if (error instanceof BlockedError) failureCode ??= error.code;
    else if (error instanceof BackendSetupError) failureCode ??= error.code;
    else failureCode ??= 'setup-backend-unavailable';
  } finally {
    await Promise.all(sessions.map((session) => session.dispose().catch(() => {})));
    for (const database of databases) database.close();
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
  return {
    evidence,
    ...(failureCode === undefined ? {} : { failureCode }),
    details: {
      credentialRead,
      isolatedConfigurations,
      backendConnected,
      remoteObjectObserved,
    },
  };
}
