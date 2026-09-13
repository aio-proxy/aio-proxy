import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AtomicConfigFile,
  createPluginRepository,
  encodeCandidate,
  type JsonValue,
  type LocalEntity,
  type PluginRepository,
} from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';

import { renameProviderIdentity } from './sync-rename';

const unauthorized = {
  withAccountTransaction: <T>(run: () => T) => run(),
  readAccount: () => null,
  renameAccount: () => false,
};

function authorize(accounts: PluginRepository, providerId: string) {
  const pending = accounts.stageAccountOperation({
    kind: 'create',
    targetDigest: 'digest:create',
    account: {
      providerId,
      plugin: '@aio-proxy/example',
      capability: 'oauth',
      fingerprint: `${providerId}-fingerprint`,
      options: {},
      secrets: {},
      credential: { accessToken: 'token' },
      catalog: { kind: 'preserve' },
    },
  });
  accounts.completeAccountOperation(pending.operationId);
  return accounts.readAccount(providerId)!;
}

const row: LocalEntity = {
  objectId: 'object',
  logicalKey: 'work',
  kind: 'provider',
  mode: 'included',
  epoch: 1,
  desired: null,
  baseline: null,
  overrides: [],
  pendingReason: null,
};

test('renaming a Provider rewrites the authored configuration and its references with the rows', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-rename-'));
  const configPath = join(home, 'config.jsonc');
  const authored = {
    providers: { work: { kind: 'api', baseUrl: 'https://work.example.test' }, other: { kind: 'api' } },
    router: { models: { 'gpt-5': { providers: { work: { priority: 10 } } } } },
    // Plugin options are opaque, so a key that merely looks like a Provider reference names
    // something upstream and must survive the rename untouched.
    plugins: [['@example/business', { providerId: 'work', providers: 'all' }]],
  };
  writeFileSync(configPath, encodeCandidate(authored, configPath));
  const rows: LocalEntity[] = [{ ...row, logicalKey: 'personal' }];
  try {
    const file = new AtomicConfigFile(configPath);
    let applied: Record<string, JsonValue> | undefined;
    let origin: string | undefined;
    let written: readonly LocalEntity[] | undefined;
    await renameProviderIdentity(
      {
        configFile: file,
        repo: {
          readBinding: () => ({ id: 'binding' }),
          entities: () => [row],
          putEntities: (_bindingId: string, entities: readonly LocalEntity[]) => void (written = entities),
        } as never,
        accounts: unauthorized,
        applyCandidate: async (raw, candidateOrigin) => {
          applied = raw;
          origin = candidateOrigin;
        },
      },
      'work',
      'personal',
      rows,
    );
    // Leaving `providers.work` behind makes the next projection miss the renamed included row.
    expect(applied?.['providers']).toEqual({
      personal: { kind: 'api', baseUrl: 'https://work.example.test' },
      other: { kind: 'api' },
    });
    expect(applied?.['router']).toEqual({ models: { 'gpt-5': { providers: { personal: { priority: 10 } } } } });
    expect(applied?.['plugins']).toEqual([['@example/business', { providerId: 'work', providers: 'all' }]]);
    // A local-origin commit would enqueue a second publication of what applyPreview already wrote.
    expect(origin).toBe('remote');
    expect(written).toEqual(rows);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('renaming an authorized Provider moves its credential onto the new Provider ID', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-rename-'));
  const configPath = join(home, 'config.jsonc');
  writeFileSync(configPath, encodeCandidate({ providers: { work: { kind: 'api' } } }, configPath));
  const db = openDb({ home });
  try {
    const accounts = createPluginRepository(db.sqlite);
    const before = authorize(accounts, 'work');
    await renameProviderIdentity(
      {
        configFile: new AtomicConfigFile(configPath),
        repo: { readBinding: () => ({ id: 'binding' }), entities: () => [], putEntities: () => {} } as never,
        accounts,
        applyCandidate: async () => {},
      },
      'work',
      'personal',
      [],
    );
    // A credential left under the old Provider ID reads as unauthorized under the new one, and
    // a bumped revision would read as a different credential to the shared-ownership row.
    expect(accounts.readAccount('work')).toBeNull();
    expect(accounts.readAccount('personal')).toEqual({ ...before, providerId: 'personal' });
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// The account move can be refused — a staged login, refresh, or removal for either Provider ID holds
// it back — and the configuration commit can fail its own verification. Committing the configuration
// first would leave the file and the runtime on the new Provider ID with the credential and the rows
// on the old one, which the consumed preview can no longer repair.
test('a configuration commit that fails leaves the credential and the rows on the old Provider ID', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-rename-rollback-'));
  const configPath = join(home, 'config.jsonc');
  writeFileSync(configPath, encodeCandidate({ providers: { work: { kind: 'api' } } }, configPath));
  const db = openDb({ home });
  try {
    const accounts = createPluginRepository(db.sqlite);
    const before = authorize(accounts, 'work');
    let stored: readonly LocalEntity[] = [row];
    await expect(
      renameProviderIdentity(
        {
          configFile: new AtomicConfigFile(configPath),
          repo: {
            readBinding: () => ({ id: 'binding' }),
            entities: () => stored,
            putEntities: (_bindingId: string, entities: readonly LocalEntity[]) => void (stored = entities),
          } as never,
          accounts,
          applyCandidate: async () => {
            throw new Error('candidate rejected');
          },
        },
        'work',
        'personal',
        [{ ...row, logicalKey: 'personal' }],
      ),
    ).rejects.toThrow('candidate rejected');
    expect(accounts.readAccount('personal')).toBeNull();
    expect(accounts.readAccount('work')).toEqual(before);
    expect(stored).toEqual([row]);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
