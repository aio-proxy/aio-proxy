import { expect, test } from 'bun:test';

import { createServerSyncFixture } from './test-support';

const repository = {
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

test('lifecycle reuses one backend session and closes it once', async () => {
  const fixture = createServerSyncFixture({
    accounts: repository,
    registry: () => ({
      resolveOAuth: () => undefined,
      oauthCapabilities: () => [],
      resolveSync: () => undefined,
      syncCapabilities: () => [],
    }),
  });
  try {
    await fixture.lifecycle.start();
    await fixture.lifecycle.start();
    expect(fixture.connectCount()).toBe(1);
    await fixture.lifecycle.close();
    await fixture.lifecycle.close();
    expect(fixture.events()).toEqual(['connected', 'disposed']);
  } finally {
    fixture.close();
  }
});
