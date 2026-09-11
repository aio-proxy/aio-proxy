import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AtomicConfigFile,
  createPluginRegistryHost,
  createPluginRepository,
  type OAuthSharingService,
} from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { zod } from '@aio-proxy/plugin-sdk';

import { createOAuthLoginSessionManager } from './manager';

test('a cancelled OAuth session stays cancelled when a committed login finishes reloading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-oauth-session-cancel-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ plugins: [], providers: {} }));
  const database = openDb({ home: dir });
  const repository = createPluginRepository(database.sqlite);
  const host = createPluginRegistryHost();
  const staging = host.stage('@example/oauth');
  staging.api.oauth.register({
    id: 'default',
    displayName: 'Example OAuth',
    account: { options: { schema: zod.object({}), form: [] } },
    credentials: zod.object({ token: zod.string() }),
    async login() {
      return { fingerprint: 'person@example.com', suggestedKey: 'person', credentials: { token: 'secret' } };
    },
    catalog: {
      policy: { kind: 'static' },
      async discover() {
        return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
      },
    },
    async createRuntime() {
      throw new Error('not used');
    },
  });
  staging.seal();
  staging.commit();

  let reloadStarted!: () => void;
  let finishReload!: () => void;
  let sessionFinished!: () => void;
  const reloading = new Promise<void>((resolve) => {
    reloadStarted = resolve;
  });
  const reloadBlocked = new Promise<void>((resolve) => {
    finishReload = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    sessionFinished = resolve;
  });
  const manager = createOAuthLoginSessionManager({
    configFile: new AtomicConfigFile(configPath),
    repository,
    acquireRegistry: () => ({ registry: host.registry, release: sessionFinished }),
    diagnostics: (code, options) => ({
      code,
      summary: code,
      retryable: options.retryable,
      occurredAt: new Date(0).toISOString(),
    }),
    logger: () => {},
    coordinateProviderCommit: (_capability, commit) => commit(),
    validateProviderCommit: () => {},
    reload: async () => {
      reloadStarted();
      await reloadBlocked;
    },
  });

  try {
    const session = manager.start({
      capability: { plugin: '@example/oauth', capability: 'default' },
      publicValues: {},
      secrets: {},
      clearSecrets: [],
    });
    await reloading;
    expect(manager.cancel(session.id)).toMatchObject({ status: 'cancelled' });
    finishReload();
    await finished;
    expect(manager.get(session.id)).toMatchObject({ status: 'cancelled' });
  } finally {
    manager.close();
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a proxy-unsupported adapter fails a Dashboard session with the stable code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-oauth-session-proxy-'));
  const configPath = join(dir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ proxy: 'https://proxy.example:8443', plugins: [], providers: {} }));
  const database = openDb({ home: dir });
  const repository = createPluginRepository(database.sqlite);
  const host = createPluginRegistryHost();
  const staging = host.stage('@example/oauth');
  let loginCalls = 0;
  staging.api.oauth.register({
    id: 'default',
    displayName: 'Example OAuth',
    supportsProxy: false,
    account: { options: { schema: zod.object({}), form: [] } },
    credentials: zod.object({ token: zod.string() }),
    async login() {
      loginCalls++;
      throw new Error('login must not run');
    },
    catalog: {
      policy: { kind: 'static' },
      async discover() {
        throw new Error('catalog must not run');
      },
    },
    async createRuntime() {
      throw new Error('runtime must not run');
    },
  });
  staging.seal();
  staging.commit();
  const finished = Promise.withResolvers<void>();
  const manager = createOAuthLoginSessionManager({
    configFile: new AtomicConfigFile(configPath),
    repository,
    acquireRegistry: () => ({ registry: host.registry, release: () => finished.resolve() }),
    diagnostics: (code, options) => ({
      code,
      summary: code,
      retryable: options.retryable,
      occurredAt: new Date(0).toISOString(),
    }),
    logger: () => {},
    coordinateProviderCommit: (_capability, commit) => commit(),
    validateProviderCommit: () => {},
    reload: async () => {},
  });

  try {
    const session = manager.start({
      capability: { plugin: '@example/oauth', capability: 'default' },
      publicValues: {},
      secrets: {},
      clearSecrets: [],
    });
    await finished.promise;
    expect(manager.get(session.id)).toMatchObject({ status: 'failed', code: 'PROXY_UNSUPPORTED' });
    expect(loginCalls).toBe(0);
  } finally {
    manager.close();
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each([
  { available: true, syncEnabled: undefined, outcome: 'coordinated' },
  { available: false, syncEnabled: undefined, outcome: 'unavailable' },
  // A device that never connected a backend keeps plain logins. The gate is asked per login, so the
  // same manager starts coordinating as soon as a backend is connected.
  { available: false, syncEnabled: false, outcome: 'plain' },
] as const)(
  're-login coordination is decided per login (available=$available, syncEnabled=$syncEnabled)',
  async ({ available, syncEnabled, outcome }) => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-oauth-session-shared-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        plugins: [],
        providers: {
          person: {
            kind: 'oauth',
            plugin: '@example/oauth',
            capability: 'default',
            enabled: true,
            options: {},
          },
        },
      }),
    );
    const database = openDb({ home: dir });
    const repository = createPluginRepository(database.sqlite);
    const operation = repository.stageAccountOperation({
      kind: 'create',
      targetDigest: 'fixture',
      account: {
        providerId: 'person',
        plugin: '@example/oauth',
        capability: 'default',
        fingerprint: 'person@example.com',
        options: {},
        secrets: {},
        credential: { token: 'old' },
        catalog: { kind: 'replace', value: { catalog: emptyCatalog(), refreshedAt: 0 } },
      },
    });
    repository.completeAccountOperation(operation.operationId);
    const host = createPluginRegistryHost();
    const staging = host.stage('@example/oauth');
    staging.api.oauth.register({
      id: 'default',
      displayName: 'Example OAuth',
      account: { options: { schema: zod.object({}), form: [] } },
      credentials: zod.object({ token: zod.string() }),
      async login() {
        return { fingerprint: 'person@example.com', suggestedKey: 'person', credentials: { token: 'replacement' } };
      },
      catalog: { policy: { kind: 'static' }, discover: async () => emptyCatalog() },
      async createRuntime() {
        throw new Error('not used');
      },
    });
    staging.seal();
    staging.commit();
    let gatedProvider: string | undefined;
    let synchronized = false;
    const sharing: OAuthSharingService = {
      share: async () => 'pending',
      replaceShared: async () => {},
      detach: async () => 'pending',
      cancelDetach() {},
      recover: async () => {},
      async synchronizeLogin(providerId, candidate) {
        expect(providerId).toBe('person');
        expect(candidate.credential).toEqual({ token: 'replacement' });
        synchronized = true;
      },
    };
    const finished = Promise.withResolvers<void>();
    const manager = createOAuthLoginSessionManager({
      configFile: new AtomicConfigFile(configPath),
      repository,
      acquireRegistry: () => ({ registry: host.registry, release: () => finished.resolve() }),
      diagnostics: (code, options) => ({
        code,
        summary: code,
        retryable: options.retryable,
        occurredAt: new Date(0).toISOString(),
      }),
      logger: () => {},
      coordinateProviderCommit: (_capability, commit) => commit(),
      validateProviderCommit: () => {},
      sharing: () => (available ? sharing : undefined),
      ...(syncEnabled === undefined ? {} : { syncEnabled: () => syncEnabled }),
      withProviderGate: async (providerId, run) => {
        gatedProvider = providerId;
        return run();
      },
      reload: async () => {
        expect(synchronized).toBe(outcome === 'coordinated');
      },
    });
    try {
      const session = manager.start({
        targetProviderId: 'person',
        publicValues: {},
        secrets: {},
        clearSecrets: [],
      });
      await finished.promise;
      expect(manager.get(session.id)).toMatchObject(
        outcome === 'unavailable'
          ? { status: 'failed', code: 'SYNC_OAUTH_COORDINATION_UNAVAILABLE' }
          : { status: 'succeeded', providerId: 'person' },
      );
      expect(repository.listPendingAccountOperations()).toHaveLength(outcome === 'unavailable' ? 1 : 0);
      expect(gatedProvider).toBe('person');
    } finally {
      manager.close();
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

function emptyCatalog() {
  return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
}
