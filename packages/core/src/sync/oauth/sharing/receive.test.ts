import { expect, test } from 'bun:test';

import { zod } from '@aio-proxy/plugin-sdk';

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

// Disconnect retires a binding only while no row holds a shared credential. An import suspended
// past that check must not record ownership afterwards: it would name an account object in a space
// no later detach can reach, and every later binding would refuse the Provider as `detach-pending`.
test('an import suspended past the disconnect check records no ownership on the retired binding', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      // A device that imports a published account has no ownership of its own yet.
      f.repo.putEntity('oauth-sharing', { ...f.repo.entities('oauth-sharing')[0]!, oauth: undefined });
      let admit!: () => void;
      let validating!: () => void;
      const held = new Promise<void>((resolve) => {
        admit = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        validating = resolve;
      });
      const adapter = {
        ...f.adapter,
        credentials: zod.object({ token: zod.string() }).refine(async () => {
          validating();
          await held;
          return true;
        }),
      };
      const receiving = f.sharing.receive(
        f.providerId,
        { adapter, plugin: '@fixture/oauth', pluginVersion: '1.0.0' },
        f.signal,
      );
      await reached;
      f.repo.clearBinding!();
      admit();

      expect(await receiving).toBeNull();
      expect(f.currentCredential()).toBeUndefined();
      expect(f.ownership()).toBeUndefined();
    },
    { shared: true, localAccount: false },
  );
});
