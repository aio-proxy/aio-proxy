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
    connect: async () => {},
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
