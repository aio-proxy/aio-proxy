import { expect, test } from 'bun:test';

import type { JsonValue } from '@aio-proxy/plugin-sdk';

import { createSyncControlPlane } from './control-plane';
import { applyOverrides } from './preview';

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
