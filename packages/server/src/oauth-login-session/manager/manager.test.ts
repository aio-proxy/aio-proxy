import { expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AtomicConfigFile, createPluginRegistryHost, createPluginRepository } from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { zod } from '@aio-proxy/plugin-sdk';

import { createOAuthLoginSessionManager } from './manager';

test.each(['valid', 'bad'] as const)(
  'a local sign-in session uses the %s host store without authorization',
  async (store) => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-oauth-session-local-'));
    const configPath = join(dir, 'config.json');
    const hostPath = join(dir, 'host-store.json');
    const secret = 'synthetic-local-session-token';
    writeFileSync(configPath, JSON.stringify({ plugins: [], providers: {} }));
    writeFileSync(hostPath, store === 'valid' ? JSON.stringify({ token: secret }) : `broken store ${secret}`);
    const database = openDb({ home: dir });
    const repository = createPluginRepository(database.sqlite);
    const host = createPluginRegistryHost();
    const staging = host.stage('@example/oauth');
    const login = mock(async () => {
      throw new Error('browser login must not run');
    });
    const read = mock(async (_context: unknown, options: { tenant: string }) => {
      expect(options).toEqual({ tenant: 'work' });
      const contents = readFileSync(hostPath, 'utf8');
      if (store === 'bad') throw new Error(contents);
      return {
        fingerprint: 'local-person',
        suggestedKey: 'person',
        credentials: zod.object({ token: zod.string() }).parse(JSON.parse(contents)),
      };
    });
    const write = mock(async () => {});
    staging.api.oauth.register({
      id: 'default',
      displayName: 'Example OAuth',
      account: {
        options: {
          schema: zod.object({ tenant: zod.string() }),
          form: [{ type: 'text', key: 'tenant', label: 'Tenant' }],
        },
      },
      credentials: zod.object({ token: zod.string() }),
      login,
      localSignIn: { source: 'Example Tool', detect: async () => existsSync(hostPath), read, write },
      catalog: {
        policy: { kind: 'static' },
        async discover(context) {
          expect(await context.credentials.read()).toMatchObject({ credential: { token: secret } });
          return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
        },
      },
      async createRuntime() {
        throw new Error('runtime must not run');
      },
    });
    staging.seal();
    staging.commit();
    const finished = Promise.withResolvers<void>();
    const logs: unknown[] = [];
    const reload = mock(async () => {});
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
      logger: (event) => {
        logs.push(event);
      },
      coordinateProviderCommit: (_capability, commit) => commit(),
      validateProviderCommit: () => {},
      reload,
    });
    try {
      const session = manager.start({
        capability: { plugin: '@example/oauth', capability: 'default' },
        localSignIn: true,
        publicValues: { tenant: 'work' },
        secrets: {},
        clearSecrets: [],
      });
      await finished.promise;
      const result = manager.get(session.id);
      expect(result).toMatchObject(
        store === 'valid'
          ? { status: 'succeeded', providerId: 'person' }
          : { status: 'failed', code: 'OAUTH_LOCAL_SIGN_IN_INVALID' },
      );
      expect(login).not.toHaveBeenCalled();
      expect(read).toHaveBeenCalledTimes(1);
      expect(write).not.toHaveBeenCalled();
      expect(JSON.stringify({ result, logs, diagnostics: repository.readDiagnostics('person') })).not.toContain(secret);
      if (store === 'valid') {
        expect(repository.readAccount('person')).toMatchObject({ localSignIn: {}, credential: { token: secret } });
        expect(reload).toHaveBeenCalledTimes(1);
      } else {
        expect(repository.readAccount('person')).toBeNull();
        expect(reload).not.toHaveBeenCalled();
      }
    } finally {
      manager.close();
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test.each([undefined, false])(
  'a browser OAuth session with localSignIn=%s avoids the host store and stays cancelled after reload',
  async (localSignIn) => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-oauth-session-cancel-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({ plugins: [], providers: {} }));
    const database = openDb({ home: dir });
    const repository = createPluginRepository(database.sqlite);
    const host = createPluginRegistryHost();
    const staging = host.stage('@example/oauth');
    const login = mock(async () => ({
      fingerprint: 'person@example.com',
      suggestedKey: 'person',
      credentials: { token: 'secret' },
    }));
    const read = mock(async () => {
      throw new Error('browser login must not read the host store');
    });
    const write = mock(async () => {});
    staging.api.oauth.register({
      id: 'default',
      displayName: 'Example OAuth',
      account: { options: { schema: zod.object({}), form: [] } },
      credentials: zod.object({ token: zod.string() }),
      login,
      localSignIn: { source: 'Example Tool', detect: async () => true, read, write },
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
        ...(localSignIn === undefined ? {} : { localSignIn }),
        publicValues: {},
        secrets: {},
        clearSecrets: [],
      });
      await reloading;
      expect(login).toHaveBeenCalledTimes(1);
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(repository.readAccount('person')?.localSignIn).toBeUndefined();
      expect(manager.cancel(session.id)).toMatchObject({ status: 'cancelled' });
      finishReload();
      await finished;
      expect(manager.get(session.id)).toMatchObject({ status: 'cancelled' });
    } finally {
      manager.close();
      database.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

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
      localSignIn: false,
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
