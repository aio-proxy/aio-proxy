import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createPluginRepository,
  createSyncRepository,
  createOAuthSharingService,
  createSyncObjectStore,
} from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { definePlugin, SyncBackendError } from '@aio-proxy/plugin-sdk';
import { ConfigSchema } from '@aio-proxy/types';

import { oauthAdapterFixture } from '../../../../core/src/sync/oauth/test-support';
import { createMemorySyncBackend } from '../../../../core/src/sync/test-support';
import { createServerState } from '../index';

test('restart reconciles a published first share before any OAuth runtime can exchange', async () => {
  const home = mkdtempSync(join(tmpdir(), 'oauth-startup-recovery-'));
  const configPath = join(home, 'config.json');
  const raw = { providers: { person: { kind: 'oauth', plugin: '@fixture/oauth', capability: 'test-capability' } } };
  writeFileSync(configPath, JSON.stringify(raw));
  const backend = createMemorySyncBackend();
  const handle = openDb({ home });
  const repo = createSyncRepository(handle.sqlite);
  const accounts = createPluginRepository(handle.sqlite);
  const binding = {
    id: 'binding',
    plugin: '@fixture/sync',
    capability: 'memory',
    pluginVersion: '1.0.0',
    identityId: 'memory-identity',
    spaceId: 'default' as const,
    deviceId: 'device',
    sessionGeneration: 1,
    options: {},
    // Seeded directly rather than through a connect: this is an established binding whose reviewed
    // Apply already completed, so a restart may reconcile it.
    connectPending: false,
  };
  repo.writeBinding(binding);
  const objectId = '00000000-0000-4000-8000-000000000001';
  repo.putEntity(binding.id, {
    objectId,
    kind: 'provider',
    logicalKey: 'person',
    mode: 'included',
    epoch: 0,
    desired: null,
    baseline: null,
    pendingReason: null,
    overrides: [],
  });
  const catalog = {
    language: [{ id: 'model' }],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
  const op = accounts.stageAccountOperation({
    kind: 'create',
    targetDigest: 'fixture',
    account: {
      providerId: 'person',
      plugin: '@fixture/oauth',
      capability: 'test-capability',
      fingerprint: 'person',
      credential: { token: 'shared' },
      options: {},
      secrets: {},
      catalog: { kind: 'replace', value: { catalog, refreshedAt: Date.now() } },
    },
  });
  accounts.completeAccountOperation(op.operationId);
  let exchanged = 0;
  let runtimeOwnership: string | undefined;
  const adapter = oauthAdapterFixture({
    credentialSync: { formatVersion: 1, multiDevice: { evidenceId: 'proof' } },
    async createRuntime({ credentials }) {
      const db = openDb({ home });
      try {
        runtimeOwnership = createSyncRepository(db.sqlite).entities(binding.id)[0]?.oauth?.mode;
      } finally {
        db.close();
      }
      const current = await credentials.read();
      if ((current.value as { token: string }).token === 'shared')
        await credentials.refresh(current.revision, async () => {
          exchanged++;
          const remote = backend.readAll().get(`s/v1/default/account/${objectId}`);
          expect(remote?.kind === 'present' && JSON.parse(new TextDecoder().decode(remote.value)).phase).toBe(
            'refreshing',
          );
          return { value: { token: 'rotated' } };
        });
      return {
        provider: {
          specificationVersion: 'v4',
          languageModel() {
            throw new Error('unused');
          },
          imageModel() {
            throw new Error('unused');
          },
          embeddingModel() {
            throw new Error('unused');
          },
        },
      } as never;
    },
  });
  const session = backend.connect();
  let wrote = false;
  const sharing = createOAuthSharingService({
    binding,
    repo,
    accounts,
    store: createSyncObjectStore({
      ...session,
      async compareAndSwap(...args) {
        await session.compareAndSwap(...args);
        wrote = true;
        throw new SyncBackendError('outcome-unknown');
      },
      async read(...args) {
        return wrote ? { kind: 'absent' } : session.read(...args);
      },
    }),
    resolveAdapter: () => ({ adapter, pluginVersion: '1.0.0' }),
    withProviderGate: async (_id, run) => run(),
  });
  expect(await sharing.share('person', new AbortController().signal)).toBe('pending');
  handle.close();
  const descriptor = definePlugin((api) => api.oauth.register(adapter));
  const syncDescriptor = definePlugin((api) =>
    api.sync.register({
      id: 'memory',
      displayName: 'Memory',
      options: adapter.account.options,
      connect: async () => backend.connect(),
    }),
  );
  let state: Awaited<ReturnType<typeof createServerState>> | undefined;
  try {
    state = await createServerState({
      config: ConfigSchema.parse(raw),
      configPath,
      dbHome: home,
      watchConfig: false,
      builtIns: [
        { packageName: '@fixture/oauth', version: '1.0.0', descriptor },
        { packageName: '@fixture/sync', version: '1.0.0', descriptor: syncDescriptor },
      ],
    });
    expect(runtimeOwnership).toBe('shared');
    expect(exchanged).toBe(1);
  } finally {
    await state?.closeAsync();
    await session.dispose();
    rmSync(home, { recursive: true, force: true });
  }
});
