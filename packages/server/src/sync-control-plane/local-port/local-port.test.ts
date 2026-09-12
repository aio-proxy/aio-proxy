import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AtomicConfigFile,
  createPluginRepository,
  createSyncRepository,
  encodeCandidate,
  recoverLocalCommits,
  type EntityBody,
  type JsonValue,
  type PluginRepository,
} from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';

import { createFifoQueue } from '../../fifo-queue';
import { createLocalSyncPort } from './local-port';

const body: EntityBody = {
  kind: 'provider',
  logicalKey: 'work',
  value: { kind: 'api', protocol: 'openai-compatible', baseUrl: 'https://example.test/v1' },
  dependencies: [],
};

test('remote apply does not persist account or entity writes after a generation change during config apply', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aio-proxy-local-port-'));
  const configPath = join(directory, 'config.jsonc');
  const config = { providers: { work: body.value } };
  writeFileSync(configPath, encodeCandidate(config, configPath));
  const database = openDb({ home: directory });
  const repo = createSyncRepository(database.sqlite);
  const binding = {
    id: 'binding',
    plugin: '@example/sync',
    capability: 'memory',
    pluginVersion: '1.0.0',
    identityId: 'identity',
    spaceId: 'default' as const,
    deviceId: 'device',
    sessionGeneration: 1,
    options: {},
  };
  repo.writeBinding(binding);
  repo.putEntity(binding.id, {
    objectId: 'object',
    logicalKey: 'work',
    kind: 'provider',
    mode: 'included',
    epoch: 0,
    desired: body,
    baseline: 'remote-1',
    overrides: [],
    pendingReason: null,
  });
  let deleteAccountCalls = 0;
  let applyCalls = 0;
  const accounts = {
    readPluginSecret: () => null,
    readAccount: () => null,
    listPendingAccountOperations: () => [],
    deleteAccount: () => {
      deleteAccountCalls++;
    },
  } as unknown as PluginRepository;
  const file = new AtomicConfigFile(configPath);
  const port = createLocalSyncPort({
    configPath,
    configFile: file,
    repo,
    accounts,
    bindingId: binding.id,
    bindingGeneration: binding.sessionGeneration,
    enqueue: createFifoQueue(),
    registry: () => ({
      resolveOAuth: () => undefined,
      oauthCapabilities: () => [],
      resolveSync: () => undefined,
      syncCapabilities: () => [],
    }),
    applyCandidate: async () => {
      applyCalls++;
      repo.writeBinding({ ...binding, sessionGeneration: 2 });
    },
  });

  try {
    await expect(port.applyRemote('object', null, 'remote-2')).rejects.toThrow('synchronization binding is stale');
    expect(applyCalls).toBe(1);
    expect(deleteAccountCalls).toBe(0);
    expect(repo.entities(binding.id)).toEqual([
      expect.objectContaining({ objectId: 'object', baseline: 'remote-1', desired: body }),
    ]);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('remote plugin import finalizes its secret before runtime validation and rolls it back on failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aio-proxy-local-port-plugin-'));
  const configPath = join(directory, 'config.jsonc');
  const plugin = '@example/business';
  writeFileSync(
    configPath,
    encodeCandidate({ plugins: [[plugin, { endpoint: 'https://old.example.test' }]], providers: {} }, configPath),
  );
  const database = openDb({ home: directory });
  const accounts = createPluginRepository(database.sqlite);
  accounts.writePluginSecret(plugin, null, { token: 'old-secret' });
  const repo = createSyncRepository(database.sqlite);
  const binding = {
    id: 'binding',
    plugin: '@example/sync',
    capability: 'memory',
    pluginVersion: '1.0.0',
    identityId: 'identity',
    spaceId: 'default' as const,
    deviceId: 'device',
    sessionGeneration: 1,
    options: {},
  };
  repo.writeBinding(binding);
  const body: EntityBody = {
    kind: 'plugin-business',
    logicalKey: plugin,
    value: { options: { endpoint: 'https://new.example.test' }, secret: { token: 'new-secret' } },
    dependencies: [],
  };
  repo.putEntity(binding.id, {
    objectId: 'plugin-object',
    logicalKey: plugin,
    kind: 'plugin-business',
    mode: 'included',
    epoch: 0,
    desired: body,
    baseline: null,
    overrides: [],
    pendingReason: null,
  });
  const file = new AtomicConfigFile(configPath);
  let observedSecret: unknown;
  let fail = false;
  const port = createLocalSyncPort({
    configPath,
    configFile: file,
    repo,
    accounts,
    bindingId: binding.id,
    bindingGeneration: binding.sessionGeneration,
    enqueue: createFifoQueue(),
    registry: () => ({
      resolveOAuth: () => undefined,
      oauthCapabilities: () => [],
      resolveSync: () => undefined,
      syncCapabilities: () => [],
    }),
    applyCandidate: async (candidate) => {
      observedSecret = accounts.readPluginSecret(plugin)?.value;
      if (fail) throw new Error('runtime rejected imported plugin');
      await file.replace(() => candidate);
    },
  });

  try {
    expect((await port.applyRemote('plugin-object', body, 'remote-plugin-op')).applied).toBe(true);
    expect(observedSecret).toEqual({ token: 'new-secret' });
    expect(accounts.readPluginSecret(plugin)?.value).toEqual({ token: 'new-secret' });

    fail = true;
    const failed = await port.applyRemote(
      'plugin-object',
      { ...body, value: { ...body.value, secret: { token: 'failed-secret' } } },
      'remote-plugin-failed',
    );
    expect(failed).toEqual({ applied: false, pending: 'invalid-config' });
    expect(observedSecret).toEqual({ token: 'failed-secret' });
    expect(accounts.readPluginSecret(plugin)?.value).toEqual({ token: 'new-secret' });
    await recoverLocalCommits(repo, binding.id, port);
    expect(repo.pendingCommits(binding.id)).toEqual([]);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a plugin tombstone removes its local secret before a restart can re-enable it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aio-proxy-local-port-tombstone-'));
  const configPath = join(directory, 'config.jsonc');
  const plugin = '@example/business';
  writeFileSync(configPath, encodeCandidate({ plugins: [plugin], providers: {} }, configPath));
  const database = openDb({ home: directory });
  const accounts = createPluginRepository(database.sqlite);
  accounts.writePluginSecret(plugin, null, { token: 'remove-me' });
  const repo = createSyncRepository(database.sqlite);
  const binding = {
    id: 'binding',
    plugin: '@example/sync',
    capability: 'memory',
    pluginVersion: '1.0.0',
    identityId: 'identity',
    spaceId: 'default' as const,
    deviceId: 'device',
    sessionGeneration: 1,
    options: {},
  };
  repo.writeBinding(binding);
  repo.putEntity(binding.id, {
    objectId: 'plugin-object',
    logicalKey: plugin,
    kind: 'plugin-business',
    mode: 'included',
    epoch: 0,
    desired: { kind: 'plugin-business', logicalKey: plugin, value: {}, dependencies: [] },
    baseline: 'old',
    overrides: [],
    pendingReason: null,
  });
  const file = new AtomicConfigFile(configPath);
  const port = createLocalSyncPort({
    configPath,
    configFile: file,
    repo,
    accounts,
    bindingId: binding.id,
    bindingGeneration: binding.sessionGeneration,
    enqueue: createFifoQueue(),
    registry: () => ({
      resolveOAuth: () => undefined,
      oauthCapabilities: () => [],
      resolveSync: () => undefined,
      syncCapabilities: () => [],
    }),
    applyCandidate: async (candidate) => file.replace(() => candidate),
  });

  try {
    expect((await port.applyRemote('plugin-object', null, 'remote-plugin-delete')).applied).toBe(true);
    expect(accounts.readPluginSecret(plugin)).toBeNull();
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a plugin tombstone CAS conflict remains pending and preserves the newer local secret', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aio-proxy-local-port-tombstone-conflict-'));
  const configPath = join(directory, 'config.jsonc');
  const plugin = '@example/business';
  writeFileSync(configPath, encodeCandidate({ plugins: [plugin], providers: {} }, configPath));
  const database = openDb({ home: directory });
  const baseAccounts = createPluginRepository(database.sqlite);
  baseAccounts.writePluginSecret(plugin, null, { token: 'newer-secret' });
  const accounts = {
    ...baseAccounts,
    deletePluginSecret: () => false,
  } as PluginRepository;
  const repo = createSyncRepository(database.sqlite);
  const binding = {
    id: 'binding',
    plugin: '@example/sync',
    capability: 'memory',
    pluginVersion: '1.0.0',
    identityId: 'identity',
    spaceId: 'default' as const,
    deviceId: 'device',
    sessionGeneration: 1,
    options: {},
  };
  repo.writeBinding(binding);
  repo.putEntity(binding.id, {
    objectId: 'plugin-object',
    logicalKey: plugin,
    kind: 'plugin-business',
    mode: 'included',
    epoch: 0,
    desired: { kind: 'plugin-business', logicalKey: plugin, value: {}, dependencies: [] },
    baseline: 'old',
    overrides: [],
    pendingReason: null,
  });
  const file = new AtomicConfigFile(configPath);
  let applyCalls = 0;
  const port = createLocalSyncPort({
    configPath,
    configFile: file,
    repo,
    accounts,
    bindingId: binding.id,
    bindingGeneration: binding.sessionGeneration,
    enqueue: createFifoQueue(),
    registry: () => ({
      resolveOAuth: () => undefined,
      oauthCapabilities: () => [],
      resolveSync: () => undefined,
      syncCapabilities: () => [],
    }),
    applyCandidate: async () => {
      applyCalls++;
    },
  });

  try {
    await expect(port.applyRemote('plugin-object', null, 'remote-plugin-delete-conflict')).resolves.toEqual({
      applied: false,
      pending: 'secret-conflict',
    });
    expect(applyCalls).toBe(0);
    expect(accounts.readPluginSecret(plugin)?.value).toEqual({ token: 'newer-secret' });
    expect(repo.entities(binding.id)[0]).toMatchObject({ baseline: 'old', pendingReason: null });
    expect(repo.pendingCommits(binding.id)).toHaveLength(1);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a plugin-secret-only remote commit recovers after reopen before remote confirmation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aio-proxy-local-port-secret-recovery-'));
  const configPath = join(directory, 'config.jsonc');
  const plugin = '@example/business';
  writeFileSync(configPath, encodeCandidate({ plugins: [plugin], providers: {} }, configPath));
  const database = openDb({ home: directory });
  const accounts = createPluginRepository(database.sqlite);
  accounts.writePluginSecret(plugin, null, { token: 'old-secret' });
  const realRepo = createSyncRepository(database.sqlite);
  const binding = {
    id: 'binding',
    plugin: '@example/sync',
    capability: 'memory',
    pluginVersion: '1.0.0',
    identityId: 'identity',
    spaceId: 'default' as const,
    deviceId: 'device',
    sessionGeneration: 1,
    options: {},
  };
  realRepo.writeBinding(binding);
  realRepo.putEntity(binding.id, {
    objectId: 'plugin-object',
    logicalKey: plugin,
    kind: 'plugin-business',
    mode: 'included',
    epoch: 0,
    desired: { kind: 'plugin-business', logicalKey: plugin, value: {}, dependencies: [] },
    baseline: 'old',
    overrides: [],
    pendingReason: null,
  });
  const file = new AtomicConfigFile(configPath);
  let failConfirm = true;
  const repo = {
    ...realRepo,
    confirm: (...args: Parameters<typeof realRepo.confirm>) => {
      if (failConfirm) {
        failConfirm = false;
        throw new Error('simulated crash before remote confirmation');
      }
      realRepo.confirm(...args);
    },
  } as typeof realRepo;
  const createPort = (currentRepo: typeof realRepo) =>
    createLocalSyncPort({
      configPath,
      configFile: file,
      repo: currentRepo,
      accounts,
      bindingId: binding.id,
      bindingGeneration: binding.sessionGeneration,
      enqueue: createFifoQueue(),
      registry: () => ({
        resolveOAuth: () => undefined,
        oauthCapabilities: () => [],
        resolveSync: () => undefined,
        syncCapabilities: () => [],
      }),
      applyCandidate: async () => {},
    });

  try {
    await expect(
      createPort(repo).applyRemote(
        'plugin-object',
        { kind: 'plugin-business', logicalKey: plugin, value: { secret: { token: 'new-secret' } }, dependencies: [] },
        'remote-plugin-secret-only',
      ),
    ).rejects.toThrow('simulated crash');
    expect(accounts.readPluginSecret(plugin)?.value).toEqual({ token: 'new-secret' });
    expect(realRepo.pendingCommits(binding.id)).toHaveLength(1);
    expect(realRepo.readCommit(binding.id, 'remote:plugin-object:remote-plugin-secret-only')?.pluginSecrets).toEqual([
      { plugin, after: { token: 'new-secret' }, before: { token: 'old-secret' } },
    ]);
    const changed = accounts.readPluginSecret(plugin);
    expect(changed).not.toBeNull();
    accounts.writePluginSecret(plugin, changed!.revision, { token: 'external-secret' });
    await recoverLocalCommits(realRepo, binding.id, createPort(realRepo));
    expect(realRepo.pendingCommits(binding.id)).toHaveLength(1);
    expect(realRepo.entities(binding.id)[0]?.baseline).toBeNull();
    expect(accounts.readPluginSecret(plugin)?.value).toEqual({ token: 'external-secret' });

    await expect(
      createPort(realRepo).applyRemote(
        'plugin-object',
        { kind: 'plugin-business', logicalKey: plugin, value: { secret: { token: 'new-secret' } }, dependencies: [] },
        'remote-plugin-secret-only',
      ),
    ).resolves.toEqual({ applied: false, pending: 'secret-conflict' });
    expect(realRepo.pendingCommits(binding.id)).toHaveLength(1);
    expect(realRepo.readCommit(binding.id, 'remote:plugin-object:remote-plugin-secret-only')?.pluginSecrets).toEqual([
      { plugin, after: { token: 'new-secret' }, before: { token: 'old-secret' } },
    ]);
    expect(accounts.readPluginSecret(plugin)?.value).toEqual({ token: 'external-secret' });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a config-changing retry preserves an uncertain remote journal and an unknown secret', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aio-proxy-local-port-config-retry-'));
  const configPath = join(directory, 'config.jsonc');
  const plugin = '@example/business';
  const initialConfig = { plugins: [[plugin, { endpoint: 'https://old.example.test' }]], providers: {} };
  writeFileSync(configPath, encodeCandidate(initialConfig, configPath));
  const database = openDb({ home: directory });
  const accounts = createPluginRepository(database.sqlite);
  accounts.writePluginSecret(plugin, null, { token: 'old-secret' });
  const realRepo = createSyncRepository(database.sqlite);
  const binding = {
    id: 'binding',
    plugin: '@example/sync',
    capability: 'memory',
    pluginVersion: '1.0.0',
    identityId: 'identity',
    spaceId: 'default' as const,
    deviceId: 'device',
    sessionGeneration: 1,
    options: {},
  };
  realRepo.writeBinding(binding);
  realRepo.putEntity(binding.id, {
    objectId: 'plugin-object',
    logicalKey: plugin,
    kind: 'plugin-business',
    mode: 'included',
    epoch: 0,
    desired: { kind: 'plugin-business', logicalKey: plugin, value: {}, dependencies: [] },
    baseline: 'old',
    overrides: [],
    pendingReason: null,
  });
  const file = new AtomicConfigFile(configPath);
  let failConfirm = true;
  const body: EntityBody = {
    kind: 'plugin-business',
    logicalKey: plugin,
    value: { options: { endpoint: 'https://new.example.test' }, secret: { token: 'new-secret' } },
    dependencies: [],
  };
  const createPort = (repo: typeof realRepo) =>
    createLocalSyncPort({
      configPath,
      configFile: file,
      repo,
      accounts,
      bindingId: binding.id,
      bindingGeneration: binding.sessionGeneration,
      enqueue: createFifoQueue(),
      registry: () => ({
        resolveOAuth: () => undefined,
        oauthCapabilities: () => [],
        resolveSync: () => undefined,
        syncCapabilities: () => [],
      }),
      applyCandidate: async (candidate) => {
        await file.replace(() => candidate);
      },
    });
  const repo = {
    ...realRepo,
    confirm: (...args: Parameters<typeof realRepo.confirm>) => {
      if (failConfirm) {
        failConfirm = false;
        throw new Error('simulated crash before remote confirmation');
      }
      realRepo.confirm(...args);
    },
  } as typeof realRepo;

  try {
    await expect(createPort(repo).applyRemote('plugin-object', body, 'remote-plugin-config-retry')).rejects.toThrow(
      'simulated crash before remote confirmation',
    );
    const prepared = realRepo.readCommit(binding.id, 'remote:plugin-object:remote-plugin-config-retry');
    expect(prepared?.phase).toBe('prepared');
    expect(await file.read()).toEqual({ plugins: [[plugin, { endpoint: 'https://new.example.test' }]], providers: {} });

    await file.replace(() => ({ plugins: [[plugin, { endpoint: 'https://external.example.test' }]], providers: {} }));
    await expect(
      createPort(realRepo).applyRemote('plugin-object', body, 'remote-plugin-config-retry'),
    ).resolves.toEqual({
      applied: false,
      pending: 'invalid-config',
    });
    expect(realRepo.pendingCommits(binding.id)).toHaveLength(1);
    expect(realRepo.readCommit(binding.id, 'remote:plugin-object:remote-plugin-config-retry')).toEqual(prepared);
    expect(await file.read()).toEqual({
      plugins: [[plugin, { endpoint: 'https://external.example.test' }]],
      providers: {},
    });

    const changedSecret = accounts.readPluginSecret(plugin);
    expect(changedSecret).not.toBeNull();
    accounts.writePluginSecret(plugin, changedSecret!.revision, { token: 'external-secret' });

    await expect(
      createPort(realRepo).applyRemote('plugin-object', body, 'remote-plugin-config-retry'),
    ).resolves.toEqual({
      applied: false,
      pending: 'secret-conflict',
    });
    expect(realRepo.pendingCommits(binding.id)).toHaveLength(1);
    expect(realRepo.readCommit(binding.id, 'remote:plugin-object:remote-plugin-config-retry')).toEqual(prepared);
    expect(await file.read()).toEqual({
      plugins: [[plugin, { endpoint: 'https://external.example.test' }]],
      providers: {},
    });
    expect(accounts.readPluginSecret(plugin)?.value).toEqual({ token: 'external-secret' });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('remote apply records the revision operation ID as the local baseline without creating outbox work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aio-proxy-local-port-baseline-'));
  const configPath = join(directory, 'config.jsonc');
  writeFileSync(configPath, encodeCandidate({ providers: { work: { ...body.value, marker: 'local' } } }, configPath));
  const database = openDb({ home: directory });
  const repo = createSyncRepository(database.sqlite);
  const accounts = {
    readPluginSecret: () => null,
    readAccount: () => null,
    listPendingAccountOperations: () => [],
  } as unknown as PluginRepository;
  const binding = {
    id: 'binding',
    plugin: '@example/sync',
    capability: 'memory',
    pluginVersion: '1.0.0',
    identityId: 'identity',
    spaceId: 'default' as const,
    deviceId: 'device',
    sessionGeneration: 1,
    options: {},
  };
  repo.writeBinding(binding);
  repo.putEntity(binding.id, {
    objectId: 'object',
    logicalKey: 'work',
    kind: 'provider',
    mode: 'included',
    epoch: 0,
    desired: body,
    baseline: 'old',
    overrides: [],
    pendingReason: null,
  });
  const file = new AtomicConfigFile(configPath);
  const port = createLocalSyncPort({
    configPath,
    configFile: file,
    repo,
    accounts,
    bindingId: binding.id,
    bindingGeneration: binding.sessionGeneration,
    enqueue: createFifoQueue(),
    registry: () => ({
      resolveOAuth: () => undefined,
      oauthCapabilities: () => [],
      resolveSync: () => undefined,
      syncCapabilities: () => [],
    }),
    applyCandidate: async (candidate) => file.replace(() => candidate),
  });

  try {
    const result = await port.applyRemote('object', body, 'remote-operation-id');
    expect(result.applied).toBe(true);
    expect(repo.entities(binding.id)[0]?.baseline).toBe('remote-operation-id');
    expect(repo.outbox(binding.id)).toEqual([]);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

async function applyRemoteBody(
  slug: string,
  config: Record<string, unknown>,
  entity: { objectId: string; logicalKey: string; kind: EntityBody['kind'] },
  remote: EntityBody,
): Promise<Record<string, unknown>> {
  const directory = mkdtempSync(join(tmpdir(), `aio-proxy-local-port-${slug}-`));
  const configPath = join(directory, 'config.jsonc');
  writeFileSync(configPath, encodeCandidate(config, configPath));
  const database = openDb({ home: directory });
  const repo = createSyncRepository(database.sqlite);
  const binding = {
    id: 'binding',
    plugin: '@example/sync',
    capability: 'memory',
    pluginVersion: '1.0.0',
    identityId: 'identity',
    spaceId: 'default' as const,
    deviceId: 'device',
    sessionGeneration: 1,
    options: {},
  };
  repo.writeBinding(binding);
  repo.putEntity(binding.id, {
    ...entity,
    mode: 'included',
    epoch: 0,
    desired: null,
    baseline: null,
    overrides: [],
    pendingReason: null,
  });
  const file = new AtomicConfigFile(configPath);
  try {
    const port = createLocalSyncPort({
      configPath,
      configFile: file,
      repo,
      accounts: {
        readPluginSecret: () => null,
        readAccount: () => null,
        deleteAccount: () => true,
        listPendingAccountOperations: () => [],
      } as unknown as PluginRepository,
      bindingId: binding.id,
      bindingGeneration: binding.sessionGeneration,
      enqueue: createFifoQueue(),
      registry: () => ({
        resolveOAuth: () => undefined,
        oauthCapabilities: () => [],
        resolveSync: () => undefined,
        syncCapabilities: () => [],
      }),
      applyCandidate: async (candidate) => file.replace(() => candidate),
    });
    expect((await port.applyRemote(entity.objectId, remote, `remote-${slug}`)).applied).toBe(true);
    return (await file.read()) as Record<string, unknown>;
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a remote Provider revision keeps the device-local proxy instead of replacing the whole Provider', async () => {
  const raw = await applyRemoteBody(
    'proxy',
    { providers: { work: { ...(body.value as object), proxy: 'http://user:secret@proxy.test:8080' } } },
    { objectId: 'object', logicalKey: 'work', kind: 'provider' },
    { ...body, value: { kind: 'api', protocol: 'openai-compatible', baseUrl: 'https://cloud.test/v1' } },
  );

  const provider = (raw['providers'] as Record<string, Record<string, unknown>>)['work']!;
  expect(provider['proxy']).toBe('http://user:secret@proxy.test:8080');
  expect(provider['baseUrl']).toBe('https://cloud.test/v1');
});

// A Provider ID is user data, so `__proto__` is a valid one. Writing it with plain assignment hit
// the legacy prototype setter, so the Provider never reached the file while the binding still
// advanced past the revision and reported it as applied.
test('a remote Provider named __proto__ reaches the serialized local configuration', async () => {
  const raw = await applyRemoteBody(
    'proto',
    { providers: {} },
    { objectId: 'object', logicalKey: '__proto__', kind: 'provider' },
    { ...body, logicalKey: '__proto__' },
  );

  const providers = raw['providers'] as Record<string, unknown>;
  expect(Object.hasOwn(providers, '__proto__')).toBe(true);
  expect(providers['__proto__']).toEqual(body.value);
});

test('a shared access body deletes the credentials it omits and leaves unrelated server settings alone', async () => {
  const raw = await applyRemoteBody(
    'access',
    { server: { host: '127.0.0.1', password: 'revoked', apiKeys: ['old'] } },
    { objectId: 'access', logicalKey: 'service-access', kind: 'service-access' },
    { kind: 'service-access', logicalKey: 'service-access', value: { apiKeys: ['fresh'] }, dependencies: [] },
  );

  const server = raw['server'] as Record<string, unknown>;
  expect(Object.hasOwn(server, 'password')).toBe(false);
  expect(server['apiKeys']).toEqual(['fresh']);
  expect(server['host']).toBe('127.0.0.1');
});

test('a routing-defaults body writes model context aggregation under router, not server', async () => {
  const raw = await applyRemoteBody(
    'routing',
    { server: {}, router: {} },
    { objectId: 'routing', logicalKey: 'routing-defaults', kind: 'routing-defaults' },
    {
      kind: 'routing-defaults',
      logicalKey: 'routing-defaults',
      value: { retry: { attempts: 3 }, modelContextAggregation: { enabled: true } },
      dependencies: [],
    },
  );

  expect((raw['router'] as Record<string, unknown>)['modelContextAggregation']).toEqual({ enabled: true });
  expect((raw['server'] as Record<string, unknown>)['retry']).toEqual({ attempts: 3 });
  expect(Object.hasOwn(raw['server'] as Record<string, unknown>, 'modelContextAggregation')).toBe(false);
});

// A published model rule carries only included Providers. Installing it verbatim used to delete the
// route this device keeps to a Provider it excluded, and `projectCommitted` re-derives the local
// remainder from the result, so the route never came back.
test('a remote model rule keeps the routes this device holds to locally excluded Providers', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'aio-proxy-local-port-model-'));
  const configPath = join(directory, 'config.jsonc');
  const config = {
    providers: { shared: { kind: 'api' }, home: { kind: 'api' } },
    router: { models: { 'gpt-5': { providers: { shared: { weight: 1 }, home: { weight: 2 } } } } },
  };
  writeFileSync(configPath, encodeCandidate(config, configPath));
  const database = openDb({ home: directory });
  const repo = createSyncRepository(database.sqlite);
  const binding = {
    id: 'binding',
    plugin: '@example/sync',
    capability: 'memory',
    pluginVersion: '1.0.0',
    identityId: 'identity',
    spaceId: 'default' as const,
    deviceId: 'device',
    sessionGeneration: 1,
    options: {},
  };
  repo.writeBinding(binding);
  const rule: EntityBody = {
    kind: 'model-rule',
    logicalKey: 'gpt-5',
    value: { providers: { shared: { weight: 1 } } },
    dependencies: [],
  };
  repo.putEntities(binding.id, [
    {
      objectId: 'provider-shared',
      logicalKey: 'shared',
      kind: 'provider',
      mode: 'included',
      epoch: 0,
      desired: { kind: 'provider', logicalKey: 'shared', value: config.providers.shared, dependencies: [] },
      baseline: 'remote-1',
      overrides: [],
      pendingReason: null,
    },
    {
      objectId: 'provider-home',
      logicalKey: 'home',
      kind: 'provider',
      mode: 'excluded',
      epoch: 0,
      desired: null,
      baseline: null,
      overrides: [],
      pendingReason: null,
    },
    {
      objectId: 'model-object',
      logicalKey: 'gpt-5',
      kind: 'model-rule',
      mode: 'included',
      epoch: 0,
      desired: rule,
      baseline: 'remote-1',
      overrides: [],
      pendingReason: null,
    },
  ]);
  const file = new AtomicConfigFile(configPath);
  const candidates: Record<string, JsonValue>[] = [];
  const port = createLocalSyncPort({
    configPath,
    configFile: file,
    repo,
    accounts: {
      readPluginSecret: () => null,
      readAccount: () => null,
      listPendingAccountOperations: () => [],
    } as unknown as PluginRepository,
    bindingId: binding.id,
    bindingGeneration: binding.sessionGeneration,
    enqueue: createFifoQueue(),
    registry: () => ({
      resolveOAuth: () => undefined,
      oauthCapabilities: () => [],
      resolveSync: () => undefined,
      syncCapabilities: () => [],
    }),
    applyCandidate: async (candidate) => {
      candidates.push(candidate);
      await file.replace(() => candidate);
    },
  });

  const routes = () => {
    const last = candidates.at(-1) as { router: { models: Record<string, unknown> } };
    return last.router.models['gpt-5'];
  };

  try {
    await port.applyRemote('model-object', { ...rule, value: { providers: { shared: { weight: 9 } } } }, 'remote-2');
    expect(routes()).toEqual({ providers: { shared: { weight: 9 }, home: { weight: 2 } } });

    // Deleting the shared rule must not take the machine-local route with it.
    await port.applyRemote('model-object', null, 'remote-3');
    expect(routes()).toEqual({ providers: { home: { weight: 2 } } });
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
