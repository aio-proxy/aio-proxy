import { expect, test } from 'bun:test';

import { createSharedOAuthCoordinator, createSyncObjectStore } from '@aio-proxy/core';

import { withOAuthSharingFixture } from '../../../../core/src/sync/oauth/test-support';
import { createSharedCredentialResolver } from './shared-credential-resolver';

test('a pending first share cannot use the local credential even without a coordinator', async () => {
  await withOAuthSharingFixture(async (f) => {
    const entity = f.repo.entities('oauth-sharing')[0]!;
    f.repo.putEntity('oauth-sharing', {
      ...entity,
      oauth: {
        mode: 'share-pending',
        epoch: 0,
        generation: 0,
        localRevision: 1,
        pluginVersion: '1.0.0',
        formatVersion: 1,
      },
    });
    const port = createSharedCredentialResolver(
      f.repo,
      f.accounts,
      () => undefined,
    )(f.providerId, f.adapter.credentials);
    expect(port).toBeDefined();
    await expect(port!.read()).rejects.toThrow('unresolved');
  });
});

test('an already-issued credential port blocks exchange after adapter evidence changes', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      const coordinator = createSharedOAuthCoordinator({
        binding: f.repo.readBinding()!,
        repo: f.repo,
        store: createSyncObjectStore(f.backend.connect()),
      });
      let adapter = f.adapter;
      const port = createSharedCredentialResolver(
        f.repo,
        f.accounts,
        () => coordinator,
        () => ({ adapter, pluginVersion: '1.0.0' }),
      )(f.providerId, adapter.credentials)!;
      expect((await port.read()).value).toEqual({ token: 'shared-token' });
      adapter = { ...adapter, credentialSync: undefined };
      let exchanges = 0;
      await expect(
        port.refresh(1, async () => {
          exchanges++;
          return { token: 'unsafe' };
        }),
      ).rejects.toThrow();
      expect(exchanges).toBe(0);
      expect(f.repo.entities('oauth-sharing')[0]?.pendingReason).toBe('pending-plugin-update');
    },
    { shared: true },
  );
});

test('switching bindings cannot turn retained shared credentials into a local account', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      f.repo.writeBinding({ ...f.repo.readBinding()!, id: 'new', identityId: 'different' });
      const port = createSharedCredentialResolver(
        f.repo,
        f.accounts,
        () => undefined,
      )(f.providerId, f.adapter.credentials);
      expect(port).toBeDefined();
      await expect(port!.read()).rejects.toThrow('unresolved');
    },
    { shared: true },
  );
});
