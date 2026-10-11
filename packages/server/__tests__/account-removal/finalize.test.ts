import { expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ABSENT_PROVIDER_DIGEST,
  AtomicConfigFile,
  createPluginRegistryHost,
  createPluginRepository,
  loginOAuthAccount,
  PENDING_OPERATION_TTL_MS,
} from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { zod } from '@aio-proxy/plugin-sdk';

import { createAccountRemovalCoordinator } from '../../src/account-removal';

test('removing a linked Provider leaves the host store bytes unchanged and never calls write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-linked-account-removal-'));
  const configPath = join(dir, 'config.json');
  const hostPath = join(dir, 'host-store.json');
  writeFileSync(configPath, JSON.stringify({ plugins: [], providers: {} }));
  writeFileSync(hostPath, '{\n  "token": "synthetic-removal-token", "extra": "preserve spacing"\n}\n');
  const database = openDb({ home: dir });
  const repository = createPluginRepository(database.sqlite);
  const file = new AtomicConfigFile(configPath);
  const host = createPluginRegistryHost();
  const staging = host.stage('@example/oauth');
  const read = mock(async () => ({
    fingerprint: 'local-person',
    suggestedKey: 'person',
    credentials: zod.object({ token: zod.string() }).parse(JSON.parse(readFileSync(hostPath, 'utf8'))),
  }));
  const write = mock(async (_context: { signal: AbortSignal }, next: { token: string }) => {
    writeFileSync(hostPath, JSON.stringify(next));
  });
  staging.api.oauth.register({
    id: 'default',
    displayName: 'Example OAuth',
    account: { options: { schema: zod.object({}), form: [] } },
    credentials: zod.object({ token: zod.string() }),
    localSignIn: { source: 'Example Tool', detect: async () => existsSync(hostPath), read, write },
    async login() {
      throw new Error('browser login must not run');
    },
    catalog: {
      policy: { kind: 'static' },
      async discover() {
        return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
      },
    },
    async createRuntime() {
      throw new Error('runtime must not run');
    },
  });
  staging.seal();
  staging.commit();
  try {
    await loginOAuthAccount({
      localSignIn: true,
      capability: { plugin: '@example/oauth', capability: 'default' },
      registry: host.registry,
      repository,
      config: file,
      renderAccountOptions: async () => ({ publicValues: {}, secrets: {} }),
      createAuthorization: () => {
        throw new Error('authorization must not run');
      },
      diagnostics: (code, options) => ({
        code,
        summary: code,
        retryable: options.retryable,
        occurredAt: new Date(0).toISOString(),
      }),
      logger: () => {},
    });
    expect(repository.readAccount('person')).toMatchObject({ localSignIn: {} });
    expect(read).toHaveBeenCalledTimes(1);
    const before = readFileSync(hostPath);
    const coordinator = createAccountRemovalCoordinator({ file, repository });
    const operations = await file.transaction(async (current) => {
      const operations = coordinator.stageRemoved(current['providers'] as Record<string, unknown>, {});
      return { next: { ...current, providers: {} }, result: operations };
    });
    expect(operations).toHaveLength(1);
    await coordinator.finalizeAfterDrain(operations, undefined);
    expect(repository.readAccount('person')).toBeNull();
    expect(repository.listPendingAccountOperations()).toEqual([]);
    expect(JSON.parse(readFileSync(configPath, 'utf8')).providers).toEqual({});
    expect(readFileSync(hostPath)).toEqual(before);
    expect(write).not.toHaveBeenCalled();
    expect(read).toHaveBeenCalledTimes(1);
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a committed delete marker schedules recovery before its retired snapshot drains', async () => {
  let releaseDrain = (): void => {};
  const whenDrained = new Promise<void>((resolve) => {
    releaseDrain = resolve;
  });
  const scheduled: number[] = [];
  const coordinator = createAccountRemovalCoordinator({
    file: {
      transaction: async (fn: (current: Record<string, unknown>) => Promise<unknown>) => fn({ providers: {} }),
    } as never,
    repository: {
      finalizeDeleteOperation() {
        return 'deleted';
      },
    } as never,
    onRecoveryNeeded: (nextRunAt) => scheduled.push(nextRunAt),
  });
  const operation = {
    operationId: 'delete:person',
    providerId: 'person',
    kind: 'delete' as const,
    targetDigest: ABSENT_PROVIDER_DIGEST,
    appliedRevision: 1,
    createdAt: 123,
  };

  const finalizing = coordinator.finalizeAfterDrain([operation], {
    providerIds: new Set(['person']),
    whenDrained,
    whenProviderDrained: () => whenDrained,
  });
  expect(scheduled).toEqual([123 + PENDING_OPERATION_TTL_MS]);
  releaseDrain();
  await finalizing;
});

test('a failed delete finalizer re-arms recovery at the marker deadline', async () => {
  const scheduled: number[] = [];
  const coordinator = createAccountRemovalCoordinator({
    file: {
      transaction() {
        throw new Error('transient finalize failure');
      },
    } as never,
    repository: {} as never,
    onRecoveryNeeded: (nextRunAt) => scheduled.push(nextRunAt),
  });
  const operation = {
    operationId: 'delete:person',
    providerId: 'person',
    kind: 'delete' as const,
    targetDigest: ABSENT_PROVIDER_DIGEST,
    appliedRevision: 1,
    createdAt: 456,
  };

  await expect(coordinator.finalizeAfterDrain([operation], undefined)).rejects.toThrow('transient finalize failure');
  expect(scheduled).toEqual([456 + PENDING_OPERATION_TTL_MS, 456 + PENDING_OPERATION_TTL_MS]);
});

test('final deletion runs through the FIFO and stays pending while a snapshot still references the account', async () => {
  const events: string[] = [];
  const scheduled: number[] = [];
  const operation = {
    operationId: 'delete:person',
    providerId: 'person',
    kind: 'delete' as const,
    targetDigest: ABSENT_PROVIDER_DIGEST,
    appliedRevision: 1,
    createdAt: 789,
  };
  const coordinator = createAccountRemovalCoordinator({
    file: {
      transaction: async (fn: (current: Record<string, unknown>) => Promise<unknown>) => {
        events.push('config-lock');
        return fn({ providers: {} });
      },
    },
    repository: {
      finalizeDeleteOperation() {
        events.push('deleted');
        return 'deleted';
      },
    },
    enqueue: async (fn: () => Promise<unknown>) => {
      events.push('fifo');
      return fn();
    },
    canDeleteAccount: () => false,
    onRecoveryNeeded: (nextRunAt: number) => scheduled.push(nextRunAt),
  } as never);

  await coordinator.finalizeAfterDrain([operation], undefined);

  expect(events).toEqual(['fifo', 'config-lock']);
  expect(scheduled).toEqual([789 + PENDING_OPERATION_TTL_MS, 789 + PENDING_OPERATION_TTL_MS]);
});

test('final deletion stays pending when the provider is present on disk', async () => {
  const events: string[] = [];
  const scheduled: number[] = [];
  const operation = {
    operationId: 'delete:person',
    providerId: 'person',
    kind: 'delete' as const,
    targetDigest: ABSENT_PROVIDER_DIGEST,
    appliedRevision: 1,
    createdAt: 987,
  };
  const coordinator = createAccountRemovalCoordinator({
    file: {
      transaction: async (fn: (current: Record<string, unknown>) => Promise<unknown>) =>
        fn({ providers: { person: { kind: 'oauth' } } }),
    },
    repository: {
      listPendingAccountOperations: () => [operation],
      completeAccountOperation() {
        events.push('completed');
      },
      finalizeDeleteOperation() {
        events.push('deleted');
        return 'deleted';
      },
    },
    onRecoveryNeeded: (nextRunAt: number) => scheduled.push(nextRunAt),
  } as never);

  await coordinator.finalizeAfterDrain([operation], undefined);

  expect(events).toEqual([]);
  expect(scheduled).toEqual([987 + PENDING_OPERATION_TTL_MS, 987 + PENDING_OPERATION_TTL_MS]);
});
