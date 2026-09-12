import { expect, test } from 'bun:test';

import { createSyncControlPlane } from './control-plane';

const BINDING = {
  id: 'binding-1',
  plugin: 'p',
  capability: 'c',
  identityId: 'i',
  spaceId: 's',
  deviceId: 'd',
  sessionGeneration: 1,
  options: {},
};

test('an override preview loads the authored source so a local-only object has a body to pin', async () => {
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
  const control = createSyncControlPlane({
    repo: { readBinding: () => BINDING, entities: () => [], outbox: () => [], pendingCommits: () => [] } as never,
    binding: () => BINDING as never,
    localEntities: () => [
      excluded('local-fresh', 'provider', 'fresh'),
      excluded('local-plugin', 'plugin-business', '@example/business'),
    ],
    remoteEntities: async () => [],
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({ remote: [], commit: async () => {}, activate: () => {}, dispose: async () => {} }),
    committedSource: async () => ({
      raw: {
        plugins: [['@example/business', { endpoint: 'https://plugin.example.test' }]],
        providers: { fresh: { kind: 'ai-sdk', packageName: '@example/business', options: { region: 'eu' } } },
      },
      accounts: new Map(),
      pluginSecrets: new Map(),
      pluginVersions: new Map([['@example/business', '1.2.3']]),
    }),
  } as never);

  const preview = await control.preview({ kind: 'overrides', objectId: 'local-fresh', paths: [['options', 'region']] });

  // A local-only object has no published body, so without the authored source the row is null and
  // applying the override persists `undefined` for the very path it was meant to keep.
  expect(preview.rows[0]).toMatchObject({ objectId: 'local-fresh', local: { options: { region: 'eu' } } });
});

test('disconnect clears the persisted binding so the next start does not reconnect', async () => {
  let cleared = 0;
  let closed = 0;
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => null,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      clearBinding: () => {
        cleared += 1;
      },
    } as never,
    binding: () => null,
    localEntities: () => [],
    remoteEntities: async () => [],
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({ remote: [], commit: async () => {}, activate: () => {}, dispose: async () => {} }),
    lifecycle: {
      activate: () => {},
      reconcile: async () => {},
      close: async () => {
        closed += 1;
      },
    },
  });

  const status = await control.disconnect();

  expect(closed).toBe(1);
  expect(cleared).toBe(1);
  expect(status.state).toBe('disconnected');
});

test('disconnect refuses to retire a binding that still owns a shared credential', async () => {
  const binding = { id: 'binding-1' };
  let cleared = 0;
  let closed = 0;
  const shared = {
    objectId: 'account-1',
    oauth: { mode: 'shared', epoch: 0, generation: 1, localRevision: 1, pluginVersion: '1.0.0', formatVersion: 1 },
  };
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => binding,
      entities: () => [shared],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      clearBinding: () => {
        cleared += 1;
      },
    } as never,
    binding: () => binding as never,
    localEntities: () => [],
    remoteEntities: async () => [],
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({ remote: [], commit: async () => {}, activate: () => {}, dispose: async () => {} }),
    lifecycle: {
      activate: () => {},
      reconcile: async () => {},
      close: async () => {
        closed += 1;
      },
    },
  });

  // Ownership names an account object in this backend's space, so a retired binding can never
  // detach it — and dropping the record would let the plain local port rotate a refresh token the
  // other devices still hold. Nothing is torn down before the user detaches.
  await expect(control.disconnect()).rejects.toMatchObject({ code: 'detach-required' });
  expect(closed).toBe(0);
  expect(cleared).toBe(0);
});
test('background engine outcomes move the publicly reported state', async () => {
  const binding = {
    id: 'binding-1',
    plugin: 'p',
    capability: 'c',
    identityId: 'i',
    spaceId: 's',
    deviceId: 'd',
    sessionGeneration: 1,
    options: {},
  };
  let handle: ((status: string) => void) | undefined;
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => binding,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
    } as never,
    binding: () => binding as never,
    localEntities: () => [],
    remoteEntities: async () => [],
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({ remote: [], commit: async () => {}, activate: () => {}, dispose: async () => {} }),
    now: () => 1_000,
    onEngineStatus: (next) => {
      handle = next;
    },
  });

  expect(control.status().state).toBe('idle');
  handle!('offline');
  expect(control.status()).toMatchObject({ state: 'offline', lastSuccessAt: null });
  handle!('quota');
  expect(control.status().state).toBe('quota');
  handle!('identity-changed');
  expect(control.status().state).toBe('identity-changed');
  handle!('online');
  expect(control.status()).toMatchObject({ state: 'idle', lastSuccessAt: 1_000 });
  // `stopped` belongs to disconnect(), which owns the terminal state itself.
  handle!('stopped');
  expect(control.status().state).toBe('idle');
});
