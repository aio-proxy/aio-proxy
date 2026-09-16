import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb } from '../../../db';
import { createPluginRepository } from '../../../plugins/repository';
import { createSyncRepository } from '../../repository';
import { applySyncedAccount } from './account-import';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

test('applies a synced account and advances local OAuth ownership together', () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-account-import-'));
  homes.push(home);
  const handle = openDb({ home });
  try {
    const accounts = createPluginRepository(handle.sqlite);
    const repo = createSyncRepository(handle.sqlite);
    const binding = {
      id: 'binding',
      plugin: '@fixture/sync',
      capability: 'default',
      pluginVersion: '1.0.0',
      identityId: 'identity',
      spaceId: 'default' as const,
      deviceId: 'device',
      sessionGeneration: 1,
      options: {},
    };
    repo.writeBinding(binding);
    repo.putEntity(binding.id, {
      objectId: 'object-1',
      logicalKey: 'provider-1',
      kind: 'provider',
      mode: 'included',
      epoch: 0,
      desired: null,
      baseline: null,
      overrides: [],
      pendingReason: null,
      oauth: {
        mode: 'shared',
        epoch: 0,
        generation: 0,
        localRevision: 1,
        pluginVersion: '1.0.0',
        formatVersion: 1,
      },
    });
    const pending = accounts.stageAccountOperation({
      kind: 'create',
      targetDigest: 'create',
      account: {
        providerId: 'provider-1',
        plugin: '@fixture/oauth',
        capability: 'default',
        fingerprint: 'fingerprint',
        options: {},
        secrets: {},
        credential: { token: 'old' },
        catalog: { kind: 'preserve' },
      },
    });
    accounts.completeAccountOperation(pending.operationId);

    const updated = applySyncedAccount({
      binding,
      account: {
        protocol: 1,
        objectId: 'object-1',
        epoch: 0,
        plugin: '@fixture/oauth',
        capability: 'default',
        pluginVersion: '1.0.0',
        formatVersion: 1,
        generation: 1,
        phase: 'ready',
        payload: { credential: { token: 'new' }, options: {}, secrets: {}, fingerprint: 'fingerprint' },
        claim: null,
        lastCompletedOperationId: null,
      },
      providerId: 'provider-1',
      repo,
      accounts,
    });

    expect(updated).toMatchObject({ credential: { token: 'new' }, revision: 2, runtimeRevision: 2 });
    expect(repo.entities(binding.id)[0]?.oauth).toEqual({
      mode: 'shared',
      epoch: 0,
      generation: 1,
      localRevision: 2,
      pluginVersion: '1.0.0',
      formatVersion: 1,
    });
  } finally {
    handle.close();
  }
});
