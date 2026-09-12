import { expect, test } from 'bun:test';

import { encode, entityKey, revisionKey } from '@aio-proxy/core';
import type { JsonValue, SyncSession } from '@aio-proxy/plugin-sdk';

import { createSyncControlPlane } from '../control-plane';
import { SyncOperationError } from '../operations';
import { listRemoteEntities } from './entities';
import { applyOverrides } from './overrides';
import { buildPreview } from './preview';

const providerBody = (value: Record<string, JsonValue>) => ({
  kind: 'provider' as const,
  logicalKey: 'work',
  value,
  dependencies: [],
});

test('overrides apply nested values, delete missing fields, copy arrays, and reject unsafe paths', () => {
  const local = providerBody({ profile: { name: 'local' }, list: [{ id: 1 }] });
  const cloud = providerBody({ profile: { name: 'cloud', keep: true }, list: [{ id: 2 }], removed: 'stale' });
  expect(applyOverrides(local, cloud, [['profile', 'name'], ['removed']])).toMatchObject({
    value: { profile: { name: 'local', keep: true }, list: [{ id: 2 }] },
  });
  expect(applyOverrides(local, cloud, [['list']]).value).toEqual({
    profile: { name: 'cloud', keep: true },
    list: [{ id: 1 }],
    removed: 'stale',
  });
  expect(() => applyOverrides(local, cloud, [['list', '0', 'id']])).toThrow();
  expect(() => applyOverrides(local, cloud, [['password']])).toThrow();
  expect(() => applyOverrides(local, cloud, [['plugin']])).toThrow();
  expect(() => applyOverrides(local, cloud, [['dependencies']])).toThrow();
  for (const metadata of [
    'package',
    'dependency',
    'identity',
    'provider',
    'packageName',
    'providerId',
    'providerID',
    'provider_id',
    'provider-id',
    'providerRef',
    'provider_reference_id',
    'accountId',
    'accountProviderId',
    'accountProviderID',
    'account_provider_id',
    'account-provider-id',
    'accountProviderRef',
    'account-provider-reference-id',
  ])
    expect(() => applyOverrides(local, cloud, [[metadata]])).toThrow();
});

test('purge previews include transitive cloud dependents and omit local-only rows', () => {
  const body = (kind: 'plugin-business', logicalKey: string, dependencies: string[] = []) => ({
    kind,
    logicalKey,
    value: {},
    dependencies: dependencies.map((objectId) => ({ objectId, packageName: 'plugin', version: '1' })),
  });
  const built = buildPreview({
    request: { kind: 'purge', scope: 'plugin', objectId: '@example/plugin' },
    local: [
      {
        objectId: 'plugin-a',
        logicalKey: '@example/plugin',
        kind: 'plugin-business',
        mode: 'included',
        epoch: 1,
        desired: body('plugin-business', '@example/plugin', ['stale-local-reference']),
        baseline: 'a',
        overrides: [],
        pendingReason: null,
      },
      {
        objectId: 'local-only',
        logicalKey: 'local',
        kind: 'plugin-business',
        mode: 'included',
        epoch: 1,
        desired: body('plugin-business', 'local', ['plugin-a']),
        baseline: null,
        overrides: [],
        pendingReason: null,
      },
    ],
    remote: [
      {
        objectId: 'plugin-a',
        logicalKey: '@example/plugin',
        kind: 'plugin-business',
        version: 'a',
        revision: 'plugin-a-revision',
        body: body('plugin-business', '@example/plugin'),
      },
      {
        objectId: 'plugin-b',
        logicalKey: 'dependent-b',
        kind: 'plugin-business',
        version: 'b',
        revision: 'plugin-b-revision',
        body: body('plugin-business', 'dependent-b', ['plugin-a']),
      },
      {
        objectId: 'plugin-c',
        logicalKey: 'dependent-c',
        kind: 'plugin-business',
        version: 'c',
        revision: 'plugin-c-revision',
        body: body('plugin-business', 'dependent-c', ['plugin-b']),
      },
    ],
    fence: { bindingId: 'binding', sessionGeneration: 1, localCommitId: '', rangeRevision: 0, remoteVersions: {} },
    previewId: 'preview',
    expiresAt: 1,
  });
  expect(built.preview.rows.map((row) => row.objectId)).toEqual(['plugin-a', 'plugin-b', 'plugin-c']);
  expect(built.record.dependencyError).toBe(false);
});

test('a local-only join projects authored bodies and pulls in the business plugin it depends on', () => {
  const authored = {
    plugins: [['@example/business', { endpoint: 'https://plugin.example.test' }]],
    providers: { fresh: { kind: 'ai-sdk', packageName: '@example/business', options: { region: 'eu' } } },
  } satisfies Record<string, JsonValue>;
  const excluded = (objectId: string, kind: 'provider' | 'plugin-business', logicalKey: string) => ({
    objectId,
    logicalKey,
    kind,
    mode: 'excluded' as const,
    epoch: 0,
    desired: null,
    baseline: null,
    overrides: [],
    pendingReason: null,
  });
  const built = buildPreview({
    request: { kind: 'join', providerId: 'fresh' },
    local: [
      excluded('local-fresh', 'provider', 'fresh'),
      excluded('local-plugin', 'plugin-business', '@example/business'),
    ],
    remote: [],
    fence: { bindingId: 'binding', sessionGeneration: 1, localCommitId: '', rangeRevision: 0, remoteVersions: {} },
    previewId: 'preview-local-only',
    expiresAt: 1,
    source: {
      raw: authored,
      accounts: new Map(),
      pluginSecrets: new Map(),
      pluginVersions: new Map([['@example/business', '1.2.3']]),
    },
  });
  // A never-published object stores no body, so without projecting the authored configuration the
  // join would preview two empty rows and publish nothing.
  expect(built.preview.rows).toEqual([
    expect.objectContaining({
      objectId: 'local-fresh',
      logicalKey: 'fresh',
      local: { kind: 'ai-sdk', packageName: '@example/business', options: { region: 'eu' } },
      choices: ['local'],
    }),
    expect.objectContaining({
      objectId: 'local-plugin',
      logicalKey: '@example/business',
      local: {
        packageName: '@example/business',
        version: '1.2.3',
        options: { endpoint: 'https://plugin.example.test' },
      },
      choices: ['local'],
    }),
  ]);
});

test('an override on a local-only object pins the authored value rather than the empty published one', () => {
  const authored = {
    plugins: [['@example/business', { endpoint: 'https://plugin.example.test' }]],
    providers: { fresh: { kind: 'ai-sdk', packageName: '@example/business', options: { region: 'eu' } } },
  } satisfies Record<string, JsonValue>;
  const excluded = (objectId: string, kind: 'provider' | 'plugin-business', logicalKey: string) => ({
    objectId,
    logicalKey,
    kind,
    mode: 'excluded' as const,
    epoch: 0,
    desired: null,
    baseline: null,
    overrides: [],
    pendingReason: null,
  });
  const built = buildPreview({
    request: { kind: 'overrides', objectId: 'local-fresh', paths: [['options', 'region']] },
    local: [
      excluded('local-fresh', 'provider', 'fresh'),
      excluded('local-plugin', 'plugin-business', '@example/business'),
    ],
    remote: [],
    fence: { bindingId: 'binding', sessionGeneration: 1, localCommitId: '', rangeRevision: 0, remoteVersions: {} },
    previewId: 'preview-overrides',
    expiresAt: 1,
    source: {
      raw: authored,
      accounts: new Map(),
      pluginSecrets: new Map(),
      pluginVersions: new Map([['@example/business', '1.2.3']]),
    },
  });

  // The row carries the body applying the override persists. Falling back to the never-published
  // `desired` would pin `undefined`, which deletes `region` from the authored configuration.
  expect(built.preview.rows.map((row) => row.objectId)).toEqual(['local-fresh']);
  expect(built.record.rows[0]?.local?.value).toMatchObject({ options: { region: 'eu' } });
});

test('a join follows published dependency object IDs instead of matching logical keys', () => {
  const cloud = (objectId: string, kind: 'provider' | 'plugin-business', logicalKey: string, dependsOn?: string) => ({
    objectId,
    logicalKey,
    kind,
    version: 'v1',
    revision: `${objectId}-revision`,
    body: {
      kind,
      logicalKey,
      value: {},
      dependencies:
        dependsOn === undefined ? [] : [{ objectId: dependsOn, packageName: '@example/business', version: '1.2.3' }],
    },
  });
  const built = buildPreview({
    request: { kind: 'join', providerId: 'fresh' },
    local: [],
    remote: [
      cloud('cloud-fresh', 'provider', 'fresh', 'cloud-plugin'),
      cloud('cloud-plugin', 'plugin-business', '@example/business', 'cloud-transitive'),
      cloud('cloud-transitive', 'plugin-business', '@example/transitive'),
      cloud('cloud-unrelated', 'provider', 'other'),
    ],
    fence: { bindingId: 'binding', sessionGeneration: 1, localCommitId: '', rangeRevision: 0, remoteVersions: {} },
    previewId: 'preview-dependencies',
    expiresAt: 1,
  });
  expect(built.preview.rows.map((row) => row.objectId)).toEqual(['cloud-fresh', 'cloud-plugin', 'cloud-transitive']);
});

test('provider purge targets the Provider ID while returning its opaque cloud object row', () => {
  const provider = (objectId: string, logicalKey: string) => ({
    kind: 'provider' as const,
    logicalKey,
    value: { plugin: '@example/plugin' },
    dependencies: [],
    objectId,
  });
  const built = buildPreview({
    request: { kind: 'purge', scope: 'provider', objectId: 'work' },
    local: [
      {
        ...provider('local-work', 'work'),
        mode: 'included',
        epoch: 1,
        desired: provider('local-work', 'work'),
        baseline: null,
        overrides: [],
        pendingReason: null,
      },
    ],
    remote: [
      {
        objectId: 'cloud-work',
        logicalKey: 'work',
        kind: 'provider',
        version: 'v1',
        revision: 'provider-revision',
        body: provider('cloud-work', 'work'),
      },
    ],
    fence: { bindingId: 'binding', sessionGeneration: 1, localCommitId: '', rangeRevision: 0, remoteVersions: {} },
    previewId: 'preview-provider',
    expiresAt: 1,
  });

  expect(built.preview.rows.map((row) => row.objectId)).toEqual(['cloud-work']);
});

test('rejoin preview is one-use, expires, and redacts candidate values', async () => {
  let remoteVersion = 'v1';
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => null,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
    } as never,
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote: [],
      refresh: async () => [],
      commit: async () => {},
      activate: () => {},
      dispose: async () => {},
    }),
    now: () => 1_000,
    binding: () => ({
      id: 'binding',
      plugin: '@example/sync',
      capability: 'memory',
      pluginVersion: '1',
      identityId: 'identity',
      spaceId: 'default',
      deviceId: 'device',
      sessionGeneration: 1,
      options: {},
    }),
    localEntities: () => [
      {
        objectId: 'object',
        logicalKey: 'work',
        kind: 'provider',
        mode: 'included',
        epoch: 1,
        desired: { kind: 'provider', logicalKey: 'work', value: { apiKey: 'work-refresh-secret' }, dependencies: [] },
        baseline: null,
        overrides: [],
        pendingReason: null,
      },
    ],
    remoteEntities: async () => [
      {
        objectId: 'object',
        logicalKey: 'work',
        kind: 'provider',
        get version() {
          return remoteVersion;
        },
        revision: 'remote-revision',
        body: { kind: 'provider', logicalKey: 'work', value: { apiKey: 'plugin-secret' }, dependencies: [] },
      },
    ],
  });
  const preview = await control.preview({ kind: 'join', providerId: 'work' });
  expect(JSON.stringify(preview)).not.toContain('work-refresh-secret');
  expect(JSON.stringify(preview)).not.toContain('plugin-secret');
  remoteVersion = 'v2';
  await expect(
    control.apply({
      previewId: preview.previewId,
      decisions: preview.rows.map((row) => ({ objectId: row.objectId, choice: 'local' as const })),
    }),
  ).rejects.toMatchObject({ code: 'preview-stale' });
  const fresh = await control.preview({ kind: 'join', providerId: 'work' });
  const applied = await control.apply({
    previewId: fresh.previewId,
    decisions: fresh.rows.map((row) => ({ objectId: row.objectId, choice: 'local' as const })),
  });
  expect(applied).toMatchObject({ state: expect.any(String) });
  await expect(control.apply({ previewId: fresh.previewId, decisions: [] })).rejects.toMatchObject({
    code: 'preview-stale',
  });
});

test('preview rejects a local commit that lands during snapshot capture', async () => {
  let commitId = 'before';
  let localReads = 0;
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => null,
      entities: () => [],
      latestConfirmedCommit: () => ({ commitId }) as never,
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
    } as never,
    binding: () => ({
      id: 'binding',
      plugin: '@example/sync',
      capability: 'memory',
      pluginVersion: '1',
      identityId: 'identity',
      spaceId: 'default',
      deviceId: 'device',
      sessionGeneration: 1,
      options: {},
    }),
    localEntities: () => {
      localReads += 1;
      if (localReads === 1) commitId = 'after';
      return [];
    },
    remoteEntities: async () => [],
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote: [],
      refresh: async () => [],
      commit: async () => {},
      activate: () => {},
      dispose: async () => {},
    }),
  });
  await expect(control.preview({ kind: 'join', providerId: 'work' })).rejects.toMatchObject({ code: 'preview-stale' });
});

test('preview redacts account option fields whose names do not reveal that they are secrets', async () => {
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => null,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
    } as never,
    binding: () => ({
      id: 'binding',
      plugin: '@example/sync',
      capability: 'memory',
      pluginVersion: '1',
      identityId: 'identity',
      spaceId: 'default',
      deviceId: 'device',
      sessionGeneration: 1,
      options: {},
    }),
    localEntities: () => [
      {
        objectId: 'object',
        logicalKey: 'work',
        kind: 'provider',
        mode: 'included',
        epoch: 1,
        desired: {
          kind: 'provider',
          logicalKey: 'work',
          value: { plugin: '@example/oauth', capability: 'main', private: 'value-to-hide' },
          dependencies: [],
        },
        baseline: null,
        overrides: [],
        pendingReason: null,
      },
    ],
    remoteEntities: async () => [],
    registry: () =>
      ({
        resolveOAuth: () => ({
          account: {
            options: {
              schema: { safeParse: () => ({ success: true }) },
              form: [{ type: 'secret', key: 'private', label: 'Private' }],
            },
          },
        }),
      }) as never,
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote: [],
      refresh: async () => [],
      commit: async () => {},
      activate: () => {},
      dispose: async () => {},
    }),
  });
  const preview = await control.preview({ kind: 'join', providerId: 'work' });
  expect(JSON.stringify(preview)).not.toContain('value-to-hide');
});

test('preview redacts Provider header values whose names do not match a secret pattern', async () => {
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => null,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
    } as never,
    binding: () => ({
      id: 'binding',
      plugin: '@example/sync',
      capability: 'memory',
      pluginVersion: '1',
      identityId: 'identity',
      spaceId: 'default',
      deviceId: 'device',
      sessionGeneration: 1,
      options: {},
    }),
    localEntities: () => [
      {
        objectId: 'object',
        logicalKey: 'work',
        kind: 'provider',
        mode: 'included',
        epoch: 1,
        desired: {
          kind: 'provider',
          logicalKey: 'work',
          value: { kind: 'api', headers: { Authorization: 'Bearer value-to-hide', Cookie: 'session=hide-me' } },
          dependencies: [],
        },
        baseline: null,
        overrides: [],
        pendingReason: null,
      },
    ],
    remoteEntities: async () => [],
    registry: () => ({ resolveOAuth: () => undefined }) as never,
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote: [],
      refresh: async () => [],
      commit: async () => {},
      activate: () => {},
      dispose: async () => {},
    }),
  });

  const preview = await control.preview({ kind: 'join', providerId: 'work' });

  expect(JSON.stringify(preview)).not.toContain('value-to-hide');
  expect(JSON.stringify(preview)).not.toContain('hide-me');
});

test('restore apply forwards the requested operation id', async () => {
  let restoredOperationId = '';
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => null,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
    } as never,
    binding: () => ({
      id: 'binding',
      plugin: '@example/sync',
      capability: 'memory',
      pluginVersion: '1',
      identityId: 'identity',
      spaceId: 'default',
      deviceId: 'device',
      sessionGeneration: 1,
      options: {},
    }),
    localEntities: () => [
      {
        objectId: 'object',
        logicalKey: 'work',
        kind: 'provider',
        mode: 'included',
        epoch: 1,
        desired: providerBody({ value: 'local' }),
        baseline: null,
        overrides: [],
        pendingReason: null,
      },
    ],
    remoteEntities: async () => [
      {
        objectId: 'object',
        logicalKey: 'work',
        kind: 'provider',
        version: 'v1',
        revision: 'provider-revision',
        body: providerBody({ value: 'current' }),
        revisions: { old: providerBody({ value: 'old' }) },
      },
    ],
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async (_objectId, _body, operationId) => {
      restoredOperationId = operationId;
    },
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote: [],
      refresh: async () => [],
      commit: async () => {},
      activate: () => {},
      dispose: async () => {},
    }),
  });
  const preview = await control.preview({ kind: 'restore', objectId: 'object', operationId: 'old' });
  await control.apply({ previewId: preview.previewId, decisions: [{ objectId: 'object', choice: 'restore' }] });
  expect(restoredOperationId).toBe('old');
});

test('same-id resolution persists the new provider ID and rewires model references atomically', async () => {
  const provider = {
    objectId: 'provider-local',
    logicalKey: 'work',
    kind: 'provider' as const,
    mode: 'included' as const,
    epoch: 1,
    desired: providerBody({ value: 'local' }),
    baseline: null,
    overrides: [],
    pendingReason: null,
  };
  const model = {
    objectId: 'model-rule',
    logicalKey: 'gpt',
    kind: 'model-rule' as const,
    mode: 'included' as const,
    epoch: 1,
    desired: {
      kind: 'model-rule' as const,
      logicalKey: 'gpt',
      value: { providers: { work: { enabled: true } } },
      dependencies: [],
    },
    baseline: null,
    overrides: [],
    pendingReason: null,
  };
  const persisted: unknown[] = [];
  const repo = {
    readBinding: () => null,
    entities: () => [provider, model],
    putEntities: (_binding: string, entities: readonly unknown[]) => persisted.push(entities),
    outbox: () => [],
    pendingCommits: () => [],
    oauthJournals: () => [],
  } as never;
  const control = createSyncControlPlane({
    repo,
    binding: () => ({
      id: 'binding',
      plugin: '@example/sync',
      capability: 'memory',
      pluginVersion: '1',
      identityId: 'identity',
      spaceId: 'default',
      deviceId: 'device',
      sessionGeneration: 1,
      options: {},
    }),
    localEntities: () => [provider, model],
    remoteEntities: async () => [
      {
        objectId: 'provider-cloud',
        logicalKey: 'work',
        kind: 'provider',
        version: 'v1',
        revision: 'provider-revision',
        body: providerBody({ value: 'cloud' }),
      },
    ],
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    persistProviderIdentity: async (_old, _new, entities) => persisted.push(entities),
    purge: async () => {},
    connect: async () => ({
      remote: [],
      refresh: async () => [],
      commit: async () => {},
      activate: () => {},
      dispose: async () => {},
    }),
  });
  const preview = await control.preview({ kind: 'join', providerId: 'work' });
  await control.apply({
    previewId: preview.previewId,
    decisions: preview.rows.map((row) => ({
      objectId: row.objectId,
      choice: (row.choices.includes('local') ? 'local' : 'cloud') as 'local' | 'cloud',
      newProviderId: 'work-renamed',
    })),
  });
  const rows = persisted[0] as Array<{
    logicalKey: string;
    desired: { value: { providers: Record<string, unknown> } };
  }>;
  expect(rows.find((row) => row.logicalKey === 'work-renamed')).toBeDefined();
  expect(rows.find((row) => row.desired?.value.providers?.['work-renamed'] !== undefined)).toBeDefined();
});

test('same-id resolution falls back to repository bulk persistence when no integration hook is provided', async () => {
  const provider = {
    objectId: 'provider-local',
    logicalKey: 'work',
    kind: 'provider' as const,
    mode: 'included' as const,
    epoch: 1,
    desired: providerBody({ value: 'local' }),
    baseline: null,
    overrides: [],
    pendingReason: null,
  };
  const model = {
    objectId: 'model-rule',
    logicalKey: 'gpt',
    kind: 'model-rule' as const,
    mode: 'included' as const,
    epoch: 1,
    desired: {
      kind: 'model-rule' as const,
      logicalKey: 'gpt',
      value: { providers: { work: { enabled: true } } },
      dependencies: [],
    },
    baseline: null,
    overrides: [],
    pendingReason: null,
  };
  let persisted: readonly (typeof provider | typeof model)[] = [];
  const repo = {
    readBinding: () => null,
    entities: () => [provider, model],
    putEntities: (_binding: string, entities: readonly (typeof provider | typeof model)[]) => {
      persisted = entities;
    },
    outbox: () => [],
    pendingCommits: () => [],
    oauthJournals: () => [],
  } as never;
  const control = createSyncControlPlane({
    repo,
    binding: () => ({
      id: 'binding',
      plugin: '@example/sync',
      capability: 'memory',
      pluginVersion: '1',
      identityId: 'identity',
      spaceId: 'default',
      deviceId: 'device',
      sessionGeneration: 1,
      options: {},
    }),
    localEntities: () => [provider, model],
    remoteEntities: async () => [
      {
        objectId: 'provider-cloud',
        logicalKey: 'work',
        kind: 'provider',
        version: 'v1',
        revision: 'provider-revision',
        body: providerBody({ value: 'cloud' }),
      },
    ],
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote: [],
      refresh: async () => [],
      commit: async () => {},
      activate: () => {},
      dispose: async () => {},
    }),
  });
  const preview = await control.preview({ kind: 'join', providerId: 'work' });
  await control.apply({
    previewId: preview.previewId,
    decisions: preview.rows.map((row) => ({
      objectId: row.objectId,
      choice: (row.choices.includes('local') ? 'local' : 'cloud') as 'local' | 'cloud',
      newProviderId: 'work-renamed',
    })),
  });
  expect(persisted.find((row) => row.logicalKey === 'work-renamed')).toBeDefined();
  expect(
    persisted.find(
      (row) => row.desired?.value && 'providers' in row.desired.value && 'work-renamed' in row.desired.value.providers,
    ),
  ).toBeDefined();
});

test('renaming a published Provider publishes a new object and deletes the identity it vacated', async () => {
  const provider = {
    objectId: 'provider-local',
    logicalKey: 'work',
    kind: 'provider' as const,
    mode: 'included' as const,
    epoch: 3,
    desired: providerBody({ value: 'local' }),
    baseline: 'local-revision',
    overrides: [],
    pendingReason: null,
  };
  const published: { objectId: string; logicalKey: string | null; expected: string | null }[] = [];
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => null,
      entities: () => [provider],
      putEntities: () => {},
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
    } as never,
    binding: () => ({
      id: 'binding',
      plugin: '@example/sync',
      capability: 'memory',
      pluginVersion: '1',
      identityId: 'identity',
      spaceId: 'default',
      deviceId: 'device',
      sessionGeneration: 1,
      options: {},
    }),
    localEntities: () => [provider],
    // The local object is itself published under `work`, and another device published a second
    // object claiming the same Provider ID. That is the collision the rename resolves.
    remoteEntities: async () => [
      {
        objectId: 'provider-local',
        logicalKey: 'work',
        kind: 'provider',
        version: 'v9',
        revision: 'local-revision',
        body: providerBody({ value: 'published' }),
      },
      {
        objectId: 'provider-cloud',
        logicalKey: 'work',
        kind: 'provider',
        version: 'v1',
        revision: 'provider-revision',
        body: providerBody({ value: 'cloud' }),
      },
    ],
    applyLocal: async () => {},
    applyCloud: async (body, current, expected) => {
      published.push({ objectId: current!.objectId, logicalKey: body?.logicalKey ?? null, expected });
    },
    restore: async () => {},
    persistOverrides: async () => {},
    persistProviderIdentity: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote: [],
      refresh: async () => [],
      commit: async () => {},
      activate: () => {},
      dispose: async () => {},
    }),
  });

  const preview = await control.preview({ kind: 'join', providerId: 'work' });
  await control.apply({
    previewId: preview.previewId,
    decisions: preview.rows.map((row) => ({
      objectId: row.objectId,
      choice: (row.objectId === 'provider-local' ? 'local' : 'cloud') as 'local' | 'cloud',
      // Every row in the collision group must name an identity; the other device's object keeps
      // the contested one, and only the local object moves aside.
      newProviderId: row.objectId === 'provider-local' ? 'work-renamed' : 'work',
    })),
  });

  const renamed = published.find((call) => call.logicalKey === 'work-renamed');
  expect(renamed).toBeDefined();
  // A renamed body cannot be pushed through the old head, whose logical key is immutable.
  expect(renamed!.objectId).not.toBe('provider-local');
  expect(renamed!.expected).toBeNull();
  // The vacated identity is removed so the cloud stops carrying two objects called `work`.
  expect(published).toContainEqual({ objectId: 'provider-local', logicalKey: null, expected: 'v9' });
});

test('manual cloud apply records the current revision operation ID instead of its storage version', async () => {
  const local = {
    objectId: 'provider-work',
    logicalKey: 'work',
    kind: 'provider' as const,
    mode: 'included' as const,
    epoch: 0,
    desired: providerBody({ value: 'local' }),
    baseline: null,
    overrides: [],
    pendingReason: null,
  };
  let saved = local;
  const repo = {
    readBinding: () => ({
      id: 'binding',
      plugin: '@example/sync',
      capability: 'memory',
      pluginVersion: '1',
      identityId: 'identity',
      spaceId: 'default' as const,
      deviceId: 'device',
      sessionGeneration: 1,
      options: {},
    }),
    entities: () => [saved],
    putEntity: (_binding: string, entity: typeof local) => {
      saved = entity;
    },
    outbox: () => [],
    pendingCommits: () => [],
    oauthJournals: () => [],
  } as never;
  const control = createSyncControlPlane({
    repo,
    localEntities: () => [saved],
    remoteEntities: async () => [
      {
        objectId: 'provider-work',
        logicalKey: 'work',
        kind: 'provider',
        version: 'storage-version-7',
        revision: 'remote-operation-7',
        body: providerBody({ value: 'cloud' }),
      },
    ],
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote: [],
      refresh: async () => [],
      commit: async () => {},
      activate: () => {},
      dispose: async () => {},
    }),
  });
  const preview = await control.preview({ kind: 'join', providerId: 'work' });
  await control.apply({
    previewId: preview.previewId,
    decisions: [{ objectId: 'provider-work', choice: 'local' }],
  });
  expect(saved.baseline).toBe('remote-operation-7');
});

test('a tombstoned remote head reports no live body so the preview offers a restore', async () => {
  const objectId = 'provider-work';
  const body = { kind: 'provider' as const, logicalKey: 'work', value: { value: 'cloud' }, dependencies: [] };
  // A delete only flips `state`; `current` keeps pointing at the last payload revision.
  const head = encode({
    protocol: 1,
    objectId,
    kind: 'provider',
    logicalKey: 'work',
    epoch: 1,
    sequence: 1,
    state: 'deleted',
    current: 'operation-1',
    history: ['operation-1'],
    reserved: [],
    cancelling: [],
    receipts: {},
    cleanupComplete: true,
  });
  const revision = encode({
    protocol: 1,
    state: 'payload',
    objectId,
    epoch: 1,
    operationId: 'operation-1',
    body,
    publishedSequence: 1,
    writtenAt: 1,
  });
  const stored = new Map<string, Uint8Array>([
    [entityKey(objectId), head],
    [revisionKey(objectId, 'operation-1'), revision],
  ]);
  const session = {
    list: async () => ({ keys: [`s/v1/default/entity/${objectId}`] }),
    read: async (key: string) => {
      const value = stored.get(key);
      return value === undefined
        ? { kind: 'absent' as const }
        : { kind: 'present' as const, value, version: 'v1', modifiedAt: 1 };
    },
  } as unknown as SyncSession;

  const remote = await listRemoteEntities(session);
  expect(remote[0]).toMatchObject({ tombstone: true, body: null, restoreBody: body });

  const built = buildPreview({
    request: { kind: 'full' },
    local: [
      {
        objectId,
        logicalKey: 'work',
        kind: 'provider',
        mode: 'included',
        epoch: 1,
        desired: body,
        baseline: 'operation-1',
        overrides: [],
        pendingReason: null,
      },
    ],
    remote,
    fence: {
      bindingId: 'binding',
      sessionGeneration: 1,
      localCommitId: 'commit',
      rangeRevision: 1,
      remoteVersions: {},
    },
    previewId: 'preview',
    expiresAt: 0,
  });
  expect(built.preview.rows[0]).toMatchObject({ change: 'delete', choices: ['restore'], cloud: null });
});

test('only Provider identity collisions demand a replacement ID', () => {
  const entity = (objectId: string, kind: 'provider' | 'plugin-business', logicalKey: string, value: JsonValue) => ({
    objectId,
    logicalKey,
    kind,
    mode: 'included' as const,
    epoch: 1,
    desired: { kind, logicalKey, value, dependencies: [] },
    baseline: 'baseline',
    overrides: [],
    pendingReason: null,
  });
  const built = buildPreview({
    request: { kind: 'full' },
    local: [
      entity('provider-a', 'provider', 'work', { value: 'a' }),
      entity('provider-b', 'provider', 'work', { value: 'b' }),
      entity('plugin-a', 'plugin-business', '@example/plugin', { value: 'a' }),
      entity('plugin-b', 'plugin-business', '@example/plugin', { value: 'b' }),
    ],
    remote: [],
    fence: {
      bindingId: 'binding',
      sessionGeneration: 1,
      localCommitId: 'commit',
      rangeRevision: 1,
      remoteVersions: {},
    },
    previewId: 'preview',
    expiresAt: 0,
  });
  const rows = new Map(built.preview.rows.map((row) => [row.objectId, row]));
  expect(rows.get('provider-a')).toMatchObject({ change: 'conflict', requiresProviderId: true });
  // A plugin cannot be renamed, so requiring a Provider ID would leave the conflict unresolvable.
  expect(rows.get('plugin-a')).toMatchObject({ change: 'conflict' });
  expect(rows.get('plugin-a')?.requiresProviderId).toBeUndefined();
  expect(built.record.rows.find((c) => c.row.objectId === 'plugin-a')?.requiresProviderId).toBeUndefined();
});

test('connect previews the candidate backend and applies the reviewed decisions', async () => {
  const cloudBody = {
    kind: 'provider' as const,
    logicalKey: 'shared',
    value: { plugin: '@example/oauth', capability: 'main' },
    dependencies: [],
  };
  const remote = [
    {
      objectId: 'cloud-object',
      logicalKey: 'shared',
      kind: 'provider',
      version: 'v1',
      revision: 'op-1',
      body: cloudBody,
    },
  ];
  const local = {
    objectId: 'local-object',
    logicalKey: 'work',
    kind: 'provider' as const,
    mode: 'included' as const,
    epoch: 2,
    desired: providerBody({ plugin: '@example/oauth', capability: 'main' }),
    baseline: 'old-backend-revision',
    overrides: [],
    pendingReason: null,
  };
  let committed = false;
  let disposed = false;
  const published: (string | null)[] = [];
  const imported: string[] = [];
  let activatedAfter: (string | null)[] | undefined;
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => null,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      putEntity: () => {},
    } as never,
    binding: () => ({
      id: 'binding',
      plugin: '@example/sync',
      capability: 'memory',
      pluginVersion: '1',
      identityId: 'identity',
      spaceId: 'default',
      deviceId: 'device',
      sessionGeneration: 1,
      options: {},
    }),
    localEntities: () => [local],
    remoteEntities: async () => remote,
    registry: () =>
      ({
        resolveSync: () => ({
          options: { schema: { safeParse: (value: unknown) => ({ success: true, data: value }) } },
        }),
        resolveOAuth: () => undefined,
      }) as never,
    applyLocal: async (_candidate, _current, objectId) => void imported.push(objectId),
    applyCloud: async (candidate) => void published.push(candidate?.logicalKey ?? null),
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote,
      refresh: async () => remote,
      commit: async () => void (committed = true),
      activate: () => void (activatedAfter = [...published, ...imported]),
      dispose: async () => void (disposed = true),
    }),
  });

  const preview = await control.preview({
    kind: 'connect',
    plugin: '@example/sync',
    capability: 'memory',
    options: {},
  });

  // The candidate's cloud state has to be visible before the swap; otherwise connecting imports it
  // without review.
  expect(preview.rows.map((row) => row.objectId).sort()).toEqual(['cloud-object', 'local-object']);
  expect(preview.rows.find((row) => row.objectId === 'cloud-object')?.choices).toEqual(['cloud']);

  await control.apply({
    previewId: preview.previewId,
    decisions: [
      { objectId: 'local-object', choice: 'local' },
      { objectId: 'cloud-object', choice: 'cloud' },
    ],
  });

  expect(committed).toBe(true);
  expect(disposed).toBe(false);
  // Discarding the decisions would leave the new backend empty while status still reports the row
  // as included.
  expect(published).toEqual(['work']);
  expect(imported).toEqual(['cloud-object']);
  // Reconciliation imports remote objects under the engine's own inclusion defaults, so starting it
  // between the swap and the decisions would transiently activate the cloud configuration.
  expect(activatedAfter).toEqual(['work', 'cloud-object']);
});

test('a failed replacement connect stops pinning preview-required', async () => {
  let attempt = 0;
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => null,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      putEntity: () => {},
    } as never,
    binding: () => ({
      id: 'binding',
      plugin: '@example/sync',
      capability: 'memory',
      pluginVersion: '1',
      identityId: 'identity',
      spaceId: 'default',
      deviceId: 'device',
      sessionGeneration: 1,
      options: {},
    }),
    localEntities: () => [],
    remoteEntities: async () => [],
    registry: () =>
      ({
        resolveSync: () => ({
          options: { schema: { safeParse: (value: unknown) => ({ success: true, data: value }) } },
        }),
        resolveOAuth: () => undefined,
      }) as never,
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => {
      attempt += 1;
      if (attempt > 1) throw new SyncOperationError('backend-unavailable');
      return { remote: [], refresh: async () => [], commit: async () => {}, dispose: async () => {} };
    },
  });
  const connect = { kind: 'connect', plugin: '@example/sync', capability: 'memory', options: {} } as const;

  await control.preview(connect);
  expect(control.status().state).toBe('preview-required');

  // Starting a second connect discards the pending candidate, so a failure here leaves no preview
  // to expire or apply — the state would stay pinned and keep suppressing engine outcomes.
  await expect(control.preview(connect)).rejects.toMatchObject({ code: 'backend-unavailable' });
  expect(control.status().state).not.toBe('preview-required');
});

test('a connect row that joins nothing is optional, and one carrying cloud state is not', async () => {
  const remote = [
    {
      objectId: 'cloud-object',
      logicalKey: 'shared',
      kind: 'provider',
      version: 'v1',
      revision: 'op-1',
      body: { kind: 'provider' as const, logicalKey: 'shared', value: { region: 'eu' }, dependencies: [] },
    },
  ];
  const local = {
    objectId: 'local-object',
    logicalKey: 'work',
    kind: 'provider' as const,
    mode: 'included' as const,
    epoch: 2,
    desired: providerBody({ plugin: '@example/oauth', capability: 'main' }),
    baseline: 'old-backend-revision',
    overrides: [],
    pendingReason: null,
  };
  const published: (string | null)[] = [];
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => null,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      putEntity: () => {},
    } as never,
    binding: () => ({
      id: 'binding',
      plugin: '@example/sync',
      capability: 'memory',
      pluginVersion: '1',
      identityId: 'identity',
      spaceId: 'default',
      deviceId: 'device',
      sessionGeneration: 1,
      options: {},
    }),
    localEntities: () => [local],
    remoteEntities: async () => remote,
    registry: () =>
      ({
        resolveSync: () => ({
          options: { schema: { safeParse: (value: unknown) => ({ success: true, data: value }) } },
        }),
        resolveOAuth: () => undefined,
      }) as never,
    applyLocal: async () => {},
    applyCloud: async (candidate) => void published.push(candidate?.logicalKey ?? null),
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote,
      refresh: async () => remote,
      commit: async () => {},
      activate: () => {},
      dispose: async () => {},
    }),
  });
  const connect = { kind: 'connect', plugin: '@example/sync', capability: 'memory', options: {} } as const;

  const preview = await control.preview(connect);
  // The dialog reads `optional` to decide which rows to leave unselected. Marking the carried
  // local-only row as required would make it preselect `local` and republish the whole
  // configuration to the new backend without the user ever choosing to.
  expect(preview.rows.find((row) => row.objectId === 'local-object')?.optional).toBe(true);
  expect(preview.rows.find((row) => row.objectId === 'cloud-object')?.optional).toBeUndefined();

  // Omitting the cloud-bearing row is still rejected: reconciliation after the swap would import it
  // unreviewed.
  await expect(
    control.apply({ previewId: preview.previewId, decisions: [{ objectId: 'local-object', choice: 'local' }] }),
  ).rejects.toMatchObject({ code: 'upgrade-required' });

  const second = await control.preview(connect);
  await control.apply({ previewId: second.previewId, decisions: [{ objectId: 'cloud-object', choice: 'cloud' }] });
  expect(published).toEqual([]);
});

test('an abandoned connect preview disposes its candidate at expiry', async () => {
  let disposed = 0;
  let committed = false;
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => null,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      putEntity: () => {},
    } as never,
    binding: () => null,
    localEntities: () => [],
    remoteEntities: async () => [],
    registry: () =>
      ({
        resolveSync: () => ({
          options: { schema: { safeParse: (value: unknown) => ({ success: true, data: value }) } },
        }),
        resolveOAuth: () => undefined,
      }) as never,
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    previewTtlMs: 10,
    connect: async () => ({
      remote: [],
      refresh: async () => [],
      commit: async () => void (committed = true),
      activate: () => {},
      dispose: async () => void (disposed += 1),
    }),
  });

  const preview = await control.preview({
    kind: 'connect',
    plugin: '@example/sync',
    capability: 'memory',
    options: {},
  });
  expect(disposed).toBe(0);

  // Nothing reads `expiresAt` unless Apply is submitted, so without a sweep the backend session
  // (a native helper process for CloudKit) would stay open until the process exits.
  await Bun.sleep(40);
  expect(disposed).toBe(1);
  expect(control.status().state).not.toBe('preview-required');

  await expect(control.apply({ previewId: preview.previewId, decisions: [] })).rejects.toMatchObject({
    code: 'preview-stale',
  });
  expect(committed).toBe(false);
  expect(disposed).toBe(1);
});

test('an abandoned join preview stops pinning preview-required at expiry', async () => {
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => null,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      putEntity: () => {},
    } as never,
    binding: () => ({
      id: 'binding',
      plugin: '@example/sync',
      capability: 'memory',
      pluginVersion: '1',
      identityId: 'identity',
      spaceId: 'default',
      deviceId: 'device',
      sessionGeneration: 1,
      options: {},
    }),
    localEntities: () => [
      {
        objectId: 'object',
        logicalKey: 'work',
        kind: 'provider',
        mode: 'excluded',
        epoch: 1,
        desired: null,
        baseline: null,
        overrides: [],
        pendingReason: null,
      },
    ],
    remoteEntities: async () => [],
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    previewTtlMs: 10,
    connect: async () => ({
      remote: [],
      refresh: async () => [],
      commit: async () => {},
      activate: () => {},
      dispose: async () => {},
    }),
  });

  await control.preview({ kind: 'join', providerId: 'work' });
  expect(control.status().state).toBe('preview-required');

  // Only connect previews were swept, so abandoning any other kind pinned `preview-required` for
  // the rest of the process and kept background engine outcomes suppressed.
  await Bun.sleep(40);
  expect(control.status().state).not.toBe('preview-required');
});

test('connect validates decisions and fences the candidate before swapping the binding', async () => {
  const cloudEntity = (version: string) => ({
    objectId: 'cloud-object',
    logicalKey: 'shared',
    kind: 'provider',
    version,
    revision: 'op-1',
    body: { kind: 'provider' as const, logicalKey: 'shared', value: {}, dependencies: [] },
  });
  let committed = 0;
  let disposed = 0;
  let cloudVersion = 'v1';
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => null,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      putEntity: () => {},
    } as never,
    binding: () => null,
    localEntities: () => [],
    remoteEntities: async () => [],
    registry: () =>
      ({
        resolveSync: () => ({
          options: { schema: { safeParse: (value: unknown) => ({ success: true, data: value }) } },
        }),
        resolveOAuth: () => undefined,
      }) as never,
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote: [cloudEntity('v1')],
      refresh: async () => [cloudEntity(cloudVersion)],
      commit: async () => void (committed += 1),
      activate: () => {},
      dispose: async () => void (disposed += 1),
    }),
  });
  const connect = { kind: 'connect', plugin: '@example/sync', capability: 'memory', options: {} } as const;

  // A decision naming a row the user never reviewed is rejected before the service switches
  // backends: the preview is consumed, so a swap here could not be retried.
  const malformed = await control.preview(connect);
  await expect(
    control.apply({ previewId: malformed.previewId, decisions: [{ objectId: 'unknown', choice: 'cloud' }] }),
  ).rejects.toMatchObject({ code: 'upgrade-required' });
  expect(committed).toBe(0);
  expect(disposed).toBe(1);

  // Same for a candidate whose cloud state moved while the preview sat: the reviewed rows no
  // longer describe it, so the binding must stay where it is.
  const drifted = await control.preview(connect);
  cloudVersion = 'v2';
  await expect(
    control.apply({ previewId: drifted.previewId, decisions: [{ objectId: 'cloud-object', choice: 'cloud' }] }),
  ).rejects.toMatchObject({
    code: 'preview-stale',
  });
  expect(committed).toBe(0);
  expect(disposed).toBe(2);

  // A connect preview with rows needs a choice for each: skipping one would leave the post-swap
  // reconciliation to import that cloud object with no explicit review.
  const skipped = await control.preview(connect);
  cloudVersion = 'v1';
  await expect(control.apply({ previewId: skipped.previewId, decisions: [] })).rejects.toMatchObject({
    code: 'upgrade-required',
  });
  expect(committed).toBe(0);
  expect(disposed).toBe(3);
});

test('a tombstoned duplicate does not collide with the live object holding the identity', () => {
  const remoteEntity = (objectId: string, tombstone: boolean) => ({
    objectId,
    logicalKey: 'work',
    kind: 'provider' as const,
    version: 'v1',
    revision: `${objectId}-revision`,
    ...(tombstone ? { tombstone: true, body: null } : { body: providerBody({ region: 'eu' }) }),
  });
  const built = buildPreview({
    request: { kind: 'join', providerId: 'work' },
    local: [],
    // A purged predecessor of the same Provider ID is still in the remote snapshot. Counting it as a
    // second claim on `provider\0work` made the surviving object a conflict demanding a rename to
    // resolve a duplicate that no longer exists.
    remote: [remoteEntity('live-object', false), remoteEntity('dead-object', true)],
    fence: { bindingId: 'binding', sessionGeneration: 1, localCommitId: '', rangeRevision: 0, remoteVersions: {} },
    previewId: 'preview',
    expiresAt: 1,
  });
  const live = built.preview.rows.find((row) => row.objectId === 'live-object');
  expect(live?.change).not.toBe('conflict');
  expect(live?.requiresProviderId).toBeUndefined();
});
