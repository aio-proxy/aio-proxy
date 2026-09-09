import { expect, test } from 'bun:test';

import { createSyncControlPlane } from './control-plane';

test('rejoin preview is one-use, expires, and redacts candidate values', async () => {
  let remoteVersion = 'v1';
  const control = createSyncControlPlane({
    repo: { readBinding: () => null } as never,
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
