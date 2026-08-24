import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AtomicConfigCommitUncertainError, AtomicConfigFile, createPluginRepository } from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { ConfigSchema } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import { seedOAuthAccount, waitUntil } from './config-store.oauth.test-support';
import { rawProvider } from './pipeline-helpers';

describe('createConfigStore OAuth reconciliation', () => {
  test.each([
    ['committed bytes', true],
    ['uncommitted bytes', false],
  ])('server reconciliation converges %s after pre-verify uncertainty', async (_label, commitCandidate) => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-store-reconcile-'));
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
    let releaseReconciliation = (): void => {};
    const reconciliationMayRun = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    let transactions = 0;
    const uncertainFile = {
      async transaction<T>(
        mutate: Parameters<AtomicConfigFile['transaction']>[0],
        options: Parameters<AtomicConfigFile['transaction']>[1] = {},
      ): Promise<T> {
        transactions++;
        if (transactions <= 2) return committedFile.transaction(mutate, options) as Promise<T>;
        if (transactions === 3) {
          const { next } = await mutate(await committedFile.read());
          if (commitCandidate) writeFileSync(configPath, JSON.stringify(next));
          throw new AtomicConfigCommitUncertainError();
        }
        await reconciliationMayRun;
        return committedFile.transaction(mutate, options) as Promise<T>;
      },
    } as AtomicConfigFile;
    const provider = rawProvider({ id: 'person' }).provider;
    const state = await createServerState({
      config: ConfigSchema.parse(initial),
      configPath,
      watchConfig: false,
      pluginRepository: repository,
      providerInstances: [provider],
      __test: { configFile: uncertainFile },
    } as never);
    const lease = state.acquireProviderSnapshot();

    try {
      await expect(state.configStore.deleteProvider('person')).rejects.toBeInstanceOf(AtomicConfigCommitUncertainError);
      expect(state.currentConfig().providers.map(({ id }) => id)).toEqual(['person']);
      expect(repository.readAccount('person')).not.toBeNull();
      expect(repository.listPendingAccountOperations()).toHaveLength(1);

      releaseReconciliation();
      await waitUntil(() => state.currentConfig().providers.some(({ id }) => id === 'person') === !commitCandidate);
      expect(repository.readAccount('person')).not.toBeNull();
      expect(repository.listPendingAccountOperations()).toHaveLength(1);

      lease.release();
      await waitUntil(() => repository.listPendingAccountOperations().length === 0);
      expect(repository.readAccount('person') === null).toBe(commitCandidate);
    } finally {
      releaseReconciliation();
      lease.release();
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
