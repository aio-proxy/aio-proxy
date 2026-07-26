import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ABSENT_PROVIDER_DIGEST,
  AtomicConfigCommitUncertainError,
  AtomicConfigFile,
  createPluginRepository,
  PENDING_OPERATION_TTL_MS,
} from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';

import { createAccountRemovalCoordinator } from '../src/account-removal';
import { createConfigStore } from '../src/config-store';
import { seedOAuthAccount, waitUntil } from './config-store.oauth.test-support';

describe('createConfigStore OAuth cleanup', () => {
  test('preserves a staged delete marker when the config commit outcome is uncertain', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-store-uncertain-'));
    const configPath = join(dir, 'config.json');
    const initial = {
      providers: {
        person: { kind: 'oauth', plugin: '@example/oauth', capability: 'default' },
      },
    };
    writeFileSync(configPath, JSON.stringify(initial));
    const handle = openDb({ home: dir });
    const repository = createPluginRepository(handle.sqlite);
    seedOAuthAccount(repository);
    const committedFile = new AtomicConfigFile(configPath);
    let releaseDrain = (): void => {};
    const whenDrained = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const scheduled: number[] = [];
    const accountRemovals = createAccountRemovalCoordinator({
      file: committedFile,
      repository,
      onRecoveryNeeded: (nextRunAt) => scheduled.push(nextRunAt),
    });
    let verified: Readonly<Record<string, unknown>> = initial;
    const uncertainFile = {
      async transaction<T>(
        mutate: Parameters<AtomicConfigFile['transaction']>[0],
        options: Parameters<AtomicConfigFile['transaction']>[1] = {},
      ): Promise<T> {
        const { next } = await mutate(await committedFile.read());
        writeFileSync(configPath, JSON.stringify(next));
        await options.verify?.(next);
        throw new AtomicConfigCommitUncertainError();
      },
    } as AtomicConfigFile;
    const store = createConfigStore({
      getConfigPath: () => configPath,
      file: uncertainFile,
      accountRemovals,
      repository,
      verify: async (candidate) => {
        verified = candidate;
        return {
          providerIds: new Set(['person']),
          whenDrained,
          whenProviderDrained: () => whenDrained,
        };
      },
    });

    try {
      await expect(store.deleteProvider('person')).rejects.toBeInstanceOf(AtomicConfigCommitUncertainError);
      expect((JSON.parse(readFileSync(configPath, 'utf8')) as typeof initial).providers).toEqual({});
      expect(verified.providers).toEqual({});
      expect(repository.readAccount('person')).not.toBeNull();
      const [marker] = repository.listPendingAccountOperations();
      expect(marker).toMatchObject({ providerId: 'person', kind: 'delete', targetDigest: ABSENT_PROVIDER_DIGEST });
      if (marker === undefined) throw new Error('delete marker fixture missing');
      expect(scheduled).toEqual([marker.createdAt + PENDING_OPERATION_TTL_MS]);

      releaseDrain();
      await waitUntil(() => repository.readAccount('person') === null);
      expect(repository.readAccount('person')).toBeNull();
      expect(repository.readCatalog('person')).toBeNull();
      expect(repository.readDiagnostics('person')).toEqual([]);
      expect(repository.listPendingAccountOperations()).toEqual([]);
    } finally {
      releaseDrain();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('compensates a staged delete marker when the config write definitely fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-store-failed-'));
    const configPath = join(dir, 'config.json');
    const initial = {
      providers: {
        person: { kind: 'oauth', plugin: '@example/oauth', capability: 'default' },
      },
    };
    writeFileSync(configPath, JSON.stringify(initial));
    const handle = openDb({ home: dir });
    const repository = createPluginRepository(handle.sqlite);
    seedOAuthAccount(repository);
    const committedFile = new AtomicConfigFile(configPath);
    const failedFile = {
      async transaction<T>(mutate: Parameters<AtomicConfigFile['transaction']>[0]): Promise<T> {
        await mutate(await committedFile.read());
        throw new Error('write failed');
      },
    } as AtomicConfigFile;
    const store = createConfigStore({
      getConfigPath: () => configPath,
      file: failedFile,
      repository,
      verify: async () => undefined,
    });

    try {
      await expect(store.deleteProvider('person')).rejects.toThrow('write failed');
      expect(repository.readAccount('person')).not.toBeNull();
      expect(repository.listPendingAccountOperations()).toEqual([]);
      expect(readFileSync(configPath, 'utf8')).toBe(JSON.stringify(initial));
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
