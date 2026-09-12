import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { encodeCandidate } from '@aio-proxy/core';

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

test('a restored binding whose plugin is missing starts once the plugin is installed', async () => {
  let available = false;
  const fixture = createServerSyncFixture({
    accounts: repository,
    registry: () => ({
      resolveOAuth: () => undefined,
      oauthCapabilities: () => [],
      resolveSync: () => undefined,
      syncCapabilities: () => [],
    }),
    backendAvailable: () => available,
  });
  try {
    await fixture.lifecycle.start();
    expect(fixture.connectCount()).toBe(0);
    // Repairing the plugin and taking the documented retry path calls start() on this same
    // lifecycle, so giving up above must not consume the one-shot start guard.
    available = true;
    await fixture.lifecycle.start();
    expect(fixture.connectCount()).toBe(1);
  } finally {
    await fixture.close();
  }
});

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
    const raw = { providers: {} };
    expect(await fixture.port.rawDigest()).toBe(
      createHash('sha256').update(encodeCandidate(raw, fixture.configPath)).digest('hex'),
    );
    await fixture.lifecycle.start();
    await fixture.lifecycle.start();
    expect(fixture.connectCount()).toBe(1);
    await fixture.lifecycle.close();
    await fixture.lifecycle.close();
    expect(fixture.events()).toEqual(['connected', 'disposed']);
  } finally {
    await fixture.close();
  }
});

test('the async fixture closes sync before its database', async () => {
  const fixture = createServerSyncFixture({
    accounts: repository,
    registry: () => ({
      resolveOAuth: () => undefined,
      oauthCapabilities: () => [],
      resolveSync: () => undefined,
      syncCapabilities: () => [],
    }),
  });
  await fixture.lifecycle.start();
  await fixture.close();
  expect(fixture.events()).toEqual(['connected', 'disposed', 'database-closed']);
});
