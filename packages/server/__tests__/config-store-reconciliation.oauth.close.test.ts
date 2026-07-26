import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AtomicConfigCommitUncertainError, AtomicConfigFile, createPluginRepository, Router } from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { ConfigSchema } from '@aio-proxy/types';

import { createServerState } from '../src/server-state';
import { deferred, seedOAuthAccount } from './config-store.oauth.test-support';
import { rawProvider } from './pipeline-helpers';

describe('createConfigStore OAuth reconciliation', () => {
  test('server close cancels a delayed reconciliation retry without an immediate failure loop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-store-reconcile-close-'));
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
    let transactions = 0;
    const uncertainFile = {
      async transaction<T>(
        mutate: Parameters<AtomicConfigFile['transaction']>[0],
        options: Parameters<AtomicConfigFile['transaction']>[1] = {},
      ): Promise<T> {
        transactions++;
        if (transactions !== 3) return committedFile.transaction(mutate, options) as Promise<T>;
        const { next } = await mutate(await committedFile.read());
        writeFileSync(configPath, JSON.stringify(next));
        throw new AtomicConfigCommitUncertainError();
      },
    } as AtomicConfigFile;
    const firstReconciliationFailed = deferred();
    const secondReconciliationFailed = deferred();
    const reconciliationFailureReported = deferred();
    const retryFailureReported = deferred();
    let reportedFailures = 0;
    let routerBuilds = 0;
    const state = await createServerState({
      config: ConfigSchema.parse(initial),
      configPath,
      watchConfig: false,
      pluginRepository: repository,
      providerInstances: [rawProvider({ id: 'person' }).provider],
      logger: () => {
        reportedFailures++;
        if (reportedFailures === 1) reconciliationFailureReported.resolve();
        if (reportedFailures === 2) retryFailureReported.resolve();
      },
      __test: {
        configFile: uncertainFile,
        reconciliationRetryMs: 50,
        createRouter(providers) {
          routerBuilds++;
          if (routerBuilds > 1) {
            if (routerBuilds === 2) firstReconciliationFailed.resolve();
            if (routerBuilds === 3) secondReconciliationFailed.resolve();
            throw new Error('persistent router failure');
          }
          return new Router(providers);
        },
      },
    } as never);

    try {
      await expect(state.configStore.deleteProvider('person')).rejects.toBeInstanceOf(AtomicConfigCommitUncertainError);
      await firstReconciliationFailed.promise;
      await reconciliationFailureReported.promise;
      expect(routerBuilds).toBe(2);
      expect(repository.listPendingAccountOperations()).toHaveLength(1);

      await Bun.sleep(10);
      expect(routerBuilds).toBe(2);
      await secondReconciliationFailed.promise;
      await retryFailureReported.promise;
      expect(routerBuilds).toBe(3);
      expect(repository.listPendingAccountOperations()).toHaveLength(1);

      await Bun.sleep(10);
      expect(routerBuilds).toBe(3);
      state.close();
      await Bun.sleep(75);
      expect(routerBuilds).toBe(3);
      expect(repository.listPendingAccountOperations()).toHaveLength(1);
    } finally {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
