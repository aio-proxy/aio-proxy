import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  accountKey,
  createSharedOAuthCoordinator,
  createSyncObjectStore,
  createSyncRepository,
  encode,
  type LiveAccount,
} from '../packages/core/src';
import { openDb } from '../packages/core/src/db';
import { createPluginRepository } from '../packages/core/src/plugins/repository';
import { createMemorySyncBackend } from '../packages/core/src/sync/test-support';
import {
  classifyInterruptedRefresh,
  classifyRotationResults,
  confirmRecoveredOAuthOperation,
  isProtectedOAuthSyncHome,
  matchesOAuthAdapter,
} from './verify-oauth-sync-live';

const script = join(import.meta.dir, 'verify-oauth-sync.ts');

async function run(env: Record<string, string>): Promise<{
  readonly exitCode: number;
  readonly output: string;
  readonly artifact: Record<string, unknown>;
}> {
  const artifactPath = join(mkdtempSync(join(tmpdir(), 'aio-proxy-oauth-runner-test-')), 'evidence.json');
  const child = Bun.spawn([process.execPath, script, '--plugin', '@aio-proxy/plugin-openrouter', '--live'], {
    env: { ...process.env, ...env, OAUTH_SYNC_EVIDENCE_PATH: artifactPath },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const output = await new Response(child.stdout).text();
  const exitCode = await child.exited;
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
  unlinkSync(artifactPath);
  rmSync(join(artifactPath, '..'), { recursive: true, force: true });
  return { exitCode, output, artifact };
}

test('blocks without an explicit isolated test home even when the account flag is set', async () => {
  const result = await run({
    OAUTH_SYNC_TEST_ACCOUNT: '1',
    OAUTH_SYNC_PROVIDER_ID: 'provider',
    OAUTH_SYNC_REMOTE_OBJECT_ID: '00000000-0000-4000-8000-000000000001',
  });
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain('"failureCode":"setup-test-home-required"');
  expect(result.artifact['failureCode']).toBe('setup-test-home-required');
  expect(result.artifact['productionGate']).toBe('blocked');
  expect(result.artifact['evidence']).toMatchObject({
    deviceBinding: 'blocked',
    independentDetach: 'blocked',
    loginEffects: 'blocked',
  });
});

test('rejects the production home before reading credentials', async () => {
  const result = await run({
    OAUTH_SYNC_TEST_HOME: join(homedir(), '.aio-proxy'),
    OAUTH_SYNC_TEST_ACCOUNT: '1',
    OAUTH_SYNC_PROVIDER_ID: 'provider',
    OAUTH_SYNC_REMOTE_OBJECT_ID: '00000000-0000-4000-8000-000000000001',
  });
  expect(result.exitCode).toBe(1);
  expect(result.artifact['failureCode']).toBe('setup-production-home');
  expect(result.artifact['account']).toMatchObject({
    credentialRead: false,
    isolatedConfigurations: 0,
  });
  expect(JSON.stringify(result.artifact)).not.toContain('production database');
});

test('rejects a symlink alias and descendants of the production home', () => {
  const root = mkdtempSync(join(tmpdir(), 'aio-proxy-oauth-home-test-'));
  const production = join(root, 'production');
  const alias = join(root, 'alias');
  mkdirSync(production);
  symlinkSync(production, alias, 'dir');
  try {
    expect(isProtectedOAuthSyncHome(alias, [production])).toBe(true);
    expect(isProtectedOAuthSyncHome(join(production, 'nested'), [production])).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requires every device rotation to succeed', () => {
  expect(
    classifyRotationResults([
      { status: 'fulfilled', value: undefined },
      { status: 'rejected', reason: new Error('one device failed') },
    ]),
  ).toBe('fail');
  expect(
    classifyRotationResults([
      { status: 'fulfilled', value: undefined },
      { status: 'fulfilled', value: undefined },
    ]),
  ).toBe('pass');
  const backendFailure = new Error('sync backend unavailable');
  backendFailure.name = 'SyncBackendError';
  expect(
    classifyRotationResults([
      { status: 'fulfilled', value: undefined },
      { status: 'rejected', reason: backendFailure },
    ]),
  ).toBe('blocked');
});

test('does not treat an ignored fulfilled interruption as uncertain recovery', () => {
  expect(
    classifyInterruptedRefresh({
      result: 'fulfilled',
      exchangeCompleted: true,
      uncertainStateObserved: true,
      recovered: true,
    }),
  ).toBe('fail');
  expect(
    classifyInterruptedRefresh({
      result: 'rejected',
      exchangeCompleted: true,
      uncertainStateObserved: true,
      recovered: true,
    }),
  ).toBe('pass');
  expect(
    classifyInterruptedRefresh({
      result: 'rejected',
      exchangeCompleted: false,
      uncertainStateObserved: false,
      recovered: false,
    }),
  ).toBe('blocked');
});

test('validates the source account against the selected adapter', () => {
  expect(matchesOAuthAdapter({ plugin: '@example/plugin', capability: 'default' }, '@example/plugin', 'default')).toBe(
    true,
  );
  expect(matchesOAuthAdapter({ plugin: '@example/other', capability: 'default' }, '@example/plugin', 'default')).toBe(
    false,
  );
});

test('applies and confirms a recovered OAuth operation before requiring an empty journal', async () => {
  const backend = createMemorySyncBackend();
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-oauth-recovery-confirm-'));
  const handle = openDb({ home });
  const session = backend.connect();
  const controller = new AbortController();
  const objectId = '00000000-0000-4000-8000-000000000001';
  const providerId = 'provider';
  const binding = {
    id: 'oauth-a',
    plugin: '@fixture/oauth',
    capability: 'test-capability',
    pluginVersion: '1.0.0',
    identityId: 'memory-identity',
    spaceId: 'default' as const,
    deviceId: 'a',
    sessionGeneration: 1,
    options: {},
  };
  const remote: LiveAccount = {
    protocol: 1,
    objectId,
    epoch: 0,
    plugin: '@fixture/oauth',
    capability: 'test-capability',
    pluginVersion: '1.0.0',
    formatVersion: 1,
    generation: 0,
    phase: 'ready',
    payload: { credential: { token: 'old' }, options: {}, secrets: {}, fingerprint: 'fixture' },
    claim: null,
    lastCompletedOperationId: null,
  };
  try {
    const accounts = createPluginRepository(handle.sqlite);
    const repo = createSyncRepository(handle.sqlite);
    repo.writeBinding(binding);
    repo.putEntity(binding.id, {
      objectId,
      logicalKey: providerId,
      kind: 'provider',
      mode: 'included',
      epoch: 0,
      desired: null,
      baseline: null,
      overrides: [],
      pendingReason: null,
      oauth: {
        mode: 'shared',
        epoch: 0,
        generation: 0,
        localRevision: 1,
        pluginVersion: '1.0.0',
        formatVersion: 1,
      },
    });
    const pending = accounts.stageAccountOperation({
      kind: 'create',
      targetDigest: 'recovery-confirm',
      account: {
        providerId,
        plugin: '@fixture/oauth',
        capability: 'test-capability',
        fingerprint: 'fixture',
        options: {},
        secrets: {},
        credential: { token: 'old' },
        catalog: { kind: 'preserve' },
      },
    });
    accounts.completeAccountOperation(pending.operationId);
    expect((await session.compareAndSwap(accountKey(objectId), null, encode(remote), controller.signal)).kind).toBe(
      'written',
    );

    const coordinator = createSharedOAuthCoordinator({
      binding,
      store: createSyncObjectStore(session),
      repo,
    });
    await expect(
      coordinator.refresh<{ readonly token: string }>(
        {
          objectId,
          epoch: 0,
          generation: 0,
          exchange: async () => {
            backend.failNext('compareAndSwap', 'before');
            return { value: { token: 'new' } };
          },
          validate: async (value: unknown) => value as { readonly token: string },
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: 'refresh-deferred' });
    const recovered = await coordinator.recover(objectId, controller.signal);
    expect(recovered?.lastCompletedOperationId).not.toBeNull();
    expect(repo.oauthJournals(binding.id)).toHaveLength(1);

    let confirmObservedAppliedState = false;
    confirmRecoveredOAuthOperation({
      account: recovered!,
      providerId,
      binding,
      repo,
      accounts,
      coordinator: {
        confirm: (confirmedObjectId, operationId) => {
          confirmObservedAppliedState = true;
          expect(accounts.readAccount(providerId)).toMatchObject({ credential: { token: 'new' } });
          expect(repo.entities(binding.id)[0]?.oauth).toMatchObject({ generation: 1, localRevision: 2 });
          coordinator.confirm(confirmedObjectId, operationId);
        },
      },
    });

    expect(confirmObservedAppliedState).toBe(true);
    expect(repo.oauthJournals(binding.id)).toEqual([]);
    const stored = await session.read(accountKey(objectId), controller.signal);
    expect(stored.kind).toBe('present');
    const reread = JSON.parse(new TextDecoder().decode(stored.value)) as LiveAccount;
    expect(reread).toMatchObject({ phase: 'ready', generation: 1, payload: { credential: { token: 'new' } } });
    expect(accounts.readAccount(providerId)).toMatchObject({ credential: { token: 'new' }, revision: 2 });
    expect(repo.entities(binding.id)[0]?.oauth).toMatchObject({ generation: 1, localRevision: 2 });
  } finally {
    controller.abort();
    await session.dispose();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});
