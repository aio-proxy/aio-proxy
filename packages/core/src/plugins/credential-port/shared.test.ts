import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { zod } from '@aio-proxy/plugin-sdk';
import type { Diagnostic } from '@aio-proxy/types';

import { openDb } from '../../db';
import type { SharedOAuthCoordinator } from '../../sync/oauth/coordinator';
import type { LiveAccount } from '../../sync/oauth/protocol';
import { createOAuthProviderGate } from '../../sync/oauth/sharing';
import { createSyncRepository, type LocalBinding, type SyncRepository } from '../../sync/repository';
import type { PluginRepository } from '../repository';
import { createPluginRepository } from '../repository';
import { createCredentialPort } from './credential-port';
import { createSharedCredentialPort } from './shared';
import { credentialPortOptions, createFixtureScope } from './test-support';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function sharedFixture(
  options: {
    readonly mode?: 'shared' | 'detach-pending';
    readonly account?: boolean;
    readonly recovered?: Partial<LiveAccount>;
  } = {},
) {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-shared-credential-port-'));
  homes.push(home);
  const handle = openDb({ home });
  const accounts = createPluginRepository(handle.sqlite);
  const repo = createSyncRepository(handle.sqlite);
  const binding: LocalBinding = {
    id: 'binding',
    plugin: '@fixture/sync',
    capability: 'default',
    pluginVersion: '1.0.0',
    identityId: 'identity',
    spaceId: 'default',
    deviceId: 'device',
    sessionGeneration: 1,
    options: {},
  };
  repo.writeBinding(binding);
  repo.putEntity(binding.id, {
    objectId: 'object-1',
    logicalKey: 'provider-1',
    kind: 'provider',
    mode: 'included',
    epoch: 0,
    desired: null,
    baseline: null,
    overrides: [],
    pendingReason: null,
    oauth: {
      mode: options.mode ?? 'shared',
      epoch: 0,
      generation: 0,
      localRevision: 1,
      pluginVersion: '1.0.0',
      formatVersion: 1,
    },
  });
  if (options.account !== false) {
    const pending = accounts.stageAccountOperation({
      kind: 'create',
      targetDigest: 'create',
      account: {
        providerId: 'provider-1',
        plugin: '@fixture/oauth',
        capability: 'default',
        fingerprint: 'fingerprint',
        options: {},
        secrets: {},
        credential: { token: 'old' },
        label: 'Old',
        expiresAt: 1,
        catalog: { kind: 'preserve' },
      },
    });
    accounts.completeAccountOperation(pending.operationId);
  }
  let recoverCalls = 0;
  let refreshCalls = 0;
  const recovered: LiveAccount = {
    protocol: 1,
    objectId: 'object-1',
    epoch: 0,
    plugin: '@fixture/oauth',
    capability: 'default',
    pluginVersion: '1.0.0',
    formatVersion: 1,
    generation: 0,
    phase: 'ready',
    payload: { credential: { token: 'old' }, options: {}, secrets: {}, fingerprint: 'fingerprint' },
    claim: null,
    lastCompletedOperationId: null,
    ...options.recovered,
  };
  const coordinator: SharedOAuthCoordinator = {
    async recover() {
      recoverCalls++;
      return recovered;
    },
    async refresh() {
      refreshCalls++;
      throw new Error('refresh should not be called');
    },
    confirm() {},
  };
  return {
    handle,
    accounts,
    repo,
    binding,
    coordinator,
    recovered,
    counts: {
      get recover() {
        return recoverCalls;
      },
      get refresh() {
        return refreshCalls;
      },
    },
  };
}

function sharedPort(
  fixture: ReturnType<typeof sharedFixture>,
  callbacks: { readonly onDiagnosticChanged?: () => void; readonly onCredentialChanged?: () => void } = {},
) {
  return createSharedCredentialPort({
    providerId: 'provider-1',
    objectId: 'object-1',
    binding: fixture.binding,
    coordinator: fixture.coordinator,
    repo: fixture.repo,
    accounts: fixture.accounts,
    schema: zod.object({ token: zod.string() }),
    ...callbacks,
  });
}

const diagnostic: Diagnostic = {
  code: 'CREDENTIAL_REFRESH_FAILED',
  summary: 'Credential refresh failed',
  retryable: false,
  occurredAt: '2026-07-15T00:00:00.000Z',
};

test('detach-pending shared ownership blocks before coordinator recovery or exchange', async () => {
  const fixture = sharedFixture({ mode: 'detach-pending' });
  try {
    await expect(sharedPort(fixture).read()).rejects.toMatchObject({ code: 'detach-pending' });
    expect(fixture.counts.recover).toBe(0);
    expect(fixture.counts.refresh).toBe(0);
  } finally {
    fixture.handle.close();
  }
});

test('imports a remote epoch replacement even when credential bytes are unchanged', async () => {
  const fixture = sharedFixture({ recovered: { epoch: 1 } });
  try {
    const snapshot = await sharedPort(fixture).read();
    expect(snapshot).toEqual({ value: { token: 'old' }, revision: 2 });
    expect(fixture.repo.entities(fixture.binding.id)[0]?.oauth).toMatchObject({
      epoch: 1,
      generation: 0,
      localRevision: 2,
    });
  } finally {
    fixture.handle.close();
  }
});

test('imports remote metadata, clears stale diagnostics, and notifies rebuild callbacks', async () => {
  const fixture = sharedFixture({
    recovered: {
      epoch: 1,
      payload: {
        credential: { token: 'old' },
        options: {},
        secrets: {},
        fingerprint: 'fingerprint',
        label: 'New',
        expiresAt: 2,
      },
    },
  });
  try {
    fixture.accounts.writeDiagnostic('provider-1', diagnostic);
    expect(fixture.accounts.readDiagnostics('provider-1')).toEqual([diagnostic]);
    let diagnosticChanges = 0;
    let credentialChanges = 0;
    await sharedPort(fixture, {
      onDiagnosticChanged: () => diagnosticChanges++,
      onCredentialChanged: () => credentialChanges++,
    }).read();
    expect(fixture.accounts.readAccount('provider-1')).toMatchObject({ label: 'New', expiresAt: 2 });
    expect(fixture.accounts.readDiagnostics('provider-1')).toEqual([]);
    expect(diagnosticChanges).toBe(1);
    expect(credentialChanges).toBe(1);
  } finally {
    fixture.handle.close();
  }
});

test('preserves login-required as a permanent shared refresh error', async () => {
  const fixture = sharedFixture({ recovered: { phase: 'login-required' } });
  try {
    await expect(sharedPort(fixture).read()).rejects.toMatchObject({ code: 'login-required' });
  } finally {
    fixture.handle.close();
  }
});

test('refuses a purged local account without consulting the coordinator', async () => {
  const fixture = sharedFixture({ account: false });
  try {
    await expect(sharedPort(fixture).read()).rejects.toThrow('Credential account is unavailable');
    expect(fixture.counts.recover).toBe(0);
  } finally {
    fixture.handle.close();
  }
});

test('does not exchange when importing a remote account incompatible with the local plugin', async () => {
  const fixture = sharedFixture({ recovered: { plugin: '@other/plugin' } });
  try {
    await expect(sharedPort(fixture).read()).rejects.toThrow('Credential account is unavailable');
    expect(fixture.accounts.readAccount('provider-1')).toMatchObject({ credential: { token: 'old' }, revision: 1 });
    expect(fixture.counts.refresh).toBe(0);
  } finally {
    fixture.handle.close();
  }
});

test('rolls back the local account import when ownership persistence fails', async () => {
  const fixture = sharedFixture({
    recovered: {
      epoch: 1,
      generation: 1,
      payload: { credential: { token: 'new' }, options: {}, secrets: {}, fingerprint: 'fingerprint' },
    },
  });
  try {
    const failingRepo = {
      ...fixture.repo,
      putEntity() {
        throw new Error('sync write failed');
      },
    } as SyncRepository;
    await expect(
      createSharedCredentialPort({
        providerId: 'provider-1',
        objectId: 'object-1',
        binding: fixture.binding,
        coordinator: fixture.coordinator,
        repo: failingRepo,
        accounts: fixture.accounts,
        schema: zod.object({ token: zod.string() }),
      }).read(),
    ).rejects.toThrow('sync write failed');
    expect(fixture.accounts.readAccount('provider-1')).toMatchObject({ credential: { token: 'old' }, revision: 1 });
    expect(fixture.repo.entities(fixture.binding.id)[0]?.oauth).toMatchObject({
      epoch: 0,
      generation: 0,
      localRevision: 1,
    });
  } finally {
    fixture.handle.close();
  }
});

test('shared refresh bypasses local lease acquisition', async () => {
  const scope = createFixtureScope();
  const { repository } = scope.open();
  try {
    let sharedCalls = 0;
    let localLeaseCalls = 0;
    const options = credentialPortOptions<{ token: string }>(repository, {
      repository: {
        ...repository,
        tryAcquireRefreshLease: (...args: Parameters<PluginRepository['tryAcquireRefreshLease']>) => {
          localLeaseCalls++;
          return repository.tryAcquireRefreshLease(...args);
        },
      },
      resolveShared: () => ({
        read: async () => ({ value: { token: 'old' }, revision: 1 }),
        refresh: async () => {
          sharedCalls++;
          return { status: 'updated', snapshot: { value: { token: 'new' }, revision: 2 } };
        },
      }),
    });
    const port = createCredentialPort(options);
    await port.refresh(1, async () => ({ value: { token: 'unused' } }));
    expect(sharedCalls).toBe(1);
    expect(localLeaseCalls).toBe(0);
  } finally {
    scope.cleanup();
  }
});

test('local refresh still acquires the local lease when ownership is absent', async () => {
  const scope = createFixtureScope();
  const { repository } = scope.open();
  try {
    let localLeaseCalls = 0;
    const options = credentialPortOptions<{ token: string }>(repository, {
      repository: {
        ...repository,
        tryAcquireRefreshLease: (...args: Parameters<PluginRepository['tryAcquireRefreshLease']>) => {
          localLeaseCalls++;
          return repository.tryAcquireRefreshLease(...args);
        },
      },
    });
    const port = createCredentialPort(options);
    await port.refresh(1, async () => ({ value: { token: 'new' } }));
    expect(localLeaseCalls).toBe(1);
  } finally {
    scope.cleanup();
  }
});

test('local and shared refresh paths wait for the common Provider gate', async () => {
  const scope = createFixtureScope();
  const { repository } = scope.open();
  try {
    const gate = createOAuthProviderGate();
    const blocked = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const blocker = gate.run('provider-1', async () => {
      entered.resolve();
      await blocked.promise;
    });
    await entered.promise;
    let exchanges = 0;
    const port = createCredentialPort(
      credentialPortOptions<{ token: string }>(repository, {
        withProviderGate: gate.run,
      }),
    );
    const refresh = port.refresh(1, async () => {
      exchanges++;
      return { value: { token: 'new' } };
    });
    await Promise.resolve();
    expect(exchanges).toBe(0);
    blocked.resolve();
    await blocker;
    await refresh;
    expect(exchanges).toBe(1);
  } finally {
    scope.cleanup();
  }
});
