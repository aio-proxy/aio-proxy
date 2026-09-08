import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AtomicConfigFile,
  createSyncRepository,
  encodeCandidate,
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
