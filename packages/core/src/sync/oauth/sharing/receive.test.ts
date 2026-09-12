import { expect, test } from 'bun:test';

import { withOAuthSharingFixture } from '../test-support';

test('a discovered Provider imports its published account so the credential can activate', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      expect(f.currentCredential()).toBeUndefined();
      const received = await f.sharing.receive(
        f.providerId,
        { adapter: f.adapter, plugin: '@fixture/oauth', pluginVersion: '1.0.0' },
        f.signal,
      );
      expect(received?.credential).toEqual({ token: 'shared-token' });
      expect(f.currentCredential()).toEqual({ token: 'shared-token' });
      expect(f.ownership()).toMatchObject({ mode: 'shared', epoch: 0, generation: 0 });
    },
    { shared: true, localAccount: false },
  );
});

test('a received account is refused when the adapter cannot verify multi-device use', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      const adapter = { ...f.adapter, credentialSync: { formatVersion: 1 } };
      expect(
        await f.sharing.receive(f.providerId, { adapter, plugin: '@fixture/oauth', pluginVersion: '1.0.0' }, f.signal),
      ).toBeNull();
      expect(f.currentCredential()).toBeUndefined();
    },
    { shared: true, localAccount: false },
  );
});

// Importing a credential the Provider does not name is unrecoverable: the stored account makes every
// later receive() return early, so activation holds the Provider unverified even once the remote
// record is corrected.
test('a received account naming another plugin or capability is refused before it is stored', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      expect(
        await f.sharing.receive(
          f.providerId,
          { adapter: f.adapter, plugin: '@other/oauth', pluginVersion: '1.0.0' },
          f.signal,
        ),
      ).toBeNull();
      expect(
        await f.sharing.receive(
          f.providerId,
          { adapter: { ...f.adapter, id: 'other-capability' }, plugin: '@fixture/oauth', pluginVersion: '1.0.0' },
          f.signal,
        ),
      ).toBeNull();
      expect(f.currentCredential()).toBeUndefined();
      expect(f.ownership()).toMatchObject({ mode: 'shared' });
    },
    { shared: true, localAccount: false },
  );
});
