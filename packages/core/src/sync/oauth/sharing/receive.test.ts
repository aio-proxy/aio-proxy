import { expect, test } from 'bun:test';

import { withOAuthSharingFixture } from '../test-support';

test('a discovered Provider imports its published account so the credential can activate', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      expect(f.currentCredential()).toBeUndefined();
      const received = await f.sharing.receive(f.providerId, { adapter: f.adapter, pluginVersion: '1.0.0' }, f.signal);
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
      expect(await f.sharing.receive(f.providerId, { adapter, pluginVersion: '1.0.0' }, f.signal)).toBeNull();
      expect(f.currentCredential()).toBeUndefined();
    },
    { shared: true, localAccount: false },
  );
});
