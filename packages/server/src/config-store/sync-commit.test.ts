import { expect, test } from 'bun:test';

import { AtomicConfigFile } from '@aio-proxy/core';

import { withSyncCommitFixture } from '../../../core/src/sync/test-support';
import { createConfigStore } from './index';

const accounts = {
  readPluginSecret: () => null,
  writePluginSecret: () => ({ value: {}, revision: 1 }),
  deletePluginSecret: () => false,
  readAccount: () => null,
  findAccountByFingerprint: () => null,
  listAccounts: () => [],
  readCatalog: () => null,
  writeCatalog: () => {},
  compareAndSwapCatalog: () => ({ ok: false as const }),
  writeCatalogUnavailableIfCurrent: () => false,
  readDiagnostics: () => [],
  writeDiagnostic: () => false,
  clearDiagnostic: () => false,
  deleteAccount: () => {},
  stageAccountOperation: () => {
    throw new Error('not used');
  },
  completeAccountOperation: () => {},
  compensateAccountOperation: () => 'compensated' as const,
  finalizeDeleteOperation: () => 'deleted' as const,
  listPendingAccountOperations: () => [],
  tryAcquireRefreshLease: () => false,
  renewRefreshLease: () => false,
  releaseRefreshLease: () => {},
  compareAndSwapCredential: () => null,
} as never;

test('config mutations capture only the finalized candidate', async () => {
  await withSyncCommitFixture(async (fixture) => {
    const store = createConfigStore({
      getConfigPath: () => fixture.configPath,
      file: new AtomicConfigFile(fixture.configPath),
      repository: accounts,
      syncCommit: { repo: fixture.repo, bindingId: fixture.bindingId, port: fixture.port },
      verify: async () => undefined,
    });
    await store.mutateConfig(() => fixture.intent.rawAfter as Record<string, unknown>);
    expect(fixture.repo.pendingCommits(fixture.bindingId)).toEqual([]);
    expect(fixture.repo.outbox(fixture.bindingId)).toHaveLength(1);
  });
});

test('verification rejection leaves no prepared sync commit', async () => {
  await withSyncCommitFixture(async (fixture) => {
    const store = createConfigStore({
      getConfigPath: () => fixture.configPath,
      file: new AtomicConfigFile(fixture.configPath),
      repository: accounts,
      syncCommit: { repo: fixture.repo, bindingId: fixture.bindingId, port: fixture.port },
      verify: async () => {
        throw new Error('invalid runtime');
      },
    });
    await expect(store.mutateConfig(() => fixture.intent.rawAfter as Record<string, unknown>)).rejects.toThrow(
      'config reload rejected: invalid runtime',
    );
    expect(fixture.repo.pendingCommits(fixture.bindingId)).toEqual([]);
    expect(fixture.repo.outbox(fixture.bindingId)).toEqual([]);
  });
});
