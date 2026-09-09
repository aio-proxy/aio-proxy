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
  type PluginRepository,
} from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';

import { createFifoQueue } from '../fifo-queue';
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
