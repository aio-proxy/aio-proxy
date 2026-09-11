import { expect, test } from 'bun:test';

import { createSyncControlPlane } from './control-plane';

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
    connect: async () => ({ remote: [], commit: async () => {}, dispose: async () => {} }),
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
    connect: async () => ({ remote: [], commit: async () => {}, dispose: async () => {} }),
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
