import { expect, test } from 'bun:test';

import type { JsonValue } from '@aio-proxy/plugin-sdk';

import { createSyncControlPlane } from './control-plane';
import { applyOverrides, buildPreview } from './preview';

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
  for (const metadata of ['package', 'dependency', 'identity', 'provider', 'packageName', 'providerId', 'accountId'])
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
        body: body('plugin-business', '@example/plugin'),
      },
      {
        objectId: 'plugin-b',
        logicalKey: 'dependent-b',
        kind: 'plugin-business',
        version: 'b',
        body: body('plugin-business', 'dependent-b', ['plugin-a']),
      },
      {
        objectId: 'plugin-c',
        logicalKey: 'dependent-c',
        kind: 'plugin-business',
        version: 'c',
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
    connect: async () => {},
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
    connect: async () => {},
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
    connect: async () => {},
  });
  const preview = await control.preview({ kind: 'join', providerId: 'work' });
  expect(JSON.stringify(preview)).not.toContain('value-to-hide');
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
    connect: async () => {},
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
        body: providerBody({ value: 'cloud' }),
      },
    ],
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    persistProviderIdentity: async (_old, _new, entities) => persisted.push(entities),
    purge: async () => {},
    connect: async () => {},
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
