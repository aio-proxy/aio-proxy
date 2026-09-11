import { expect, test } from 'bun:test';

import { oauthAdapterFixture, withOAuthSharingFixture } from '../test-support';

test('a login during a pending detachment stays local so the next attempt can prove independence', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      f.replaceAdapter({
        ...f.adapter,
        credentialSync: {
          formatVersion: 1,
          multiDevice: { evidenceId: 'fixture-evidence' },
          // Independence requires the shared credential to stay behind: an authorization that was
          // already published to every other device is the same authorization.
          canDetach: async ({ shared, candidate }) =>
            (shared as { token: string }).token !== (candidate as { token: string }).token,
        },
      });
      expect(await f.sharing.detach(f.providerId, f.accountWrite, f.signal)).toBe('pending');
      expect(f.ownership()?.mode).toBe('detach-pending');

      const relogin = { ...f.accountWrite, credential: { token: 'independent-token' } };
      await f.sharing.synchronizeLogin(f.providerId, relogin, f.signal);
      expect(f.remote()?.payload.credential).toEqual({ token: 'shared-token' });
      expect(f.ownership()?.mode).toBe('detach-pending');

      expect(await f.sharing.detach(f.providerId, relogin, f.signal)).toBe('independent');
      expect(f.ownership()?.mode).toBe('independent');
      expect(f.repo.oauthJournals('oauth-sharing')).toEqual([]);
    },
    { shared: true },
  );
});

test('different token strings do not complete independent detachment', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      f.replaceAdapter({
        ...f.adapter,
        credentialSync: {
          formatVersion: 1,
          multiDevice: { evidenceId: 'fixture-evidence' },
          canDetach: async () => false,
        },
      });
      const candidate = { ...f.accountWrite, credential: { token: 'different-token' } };
      expect(await f.sharing.detach(f.providerId, candidate, f.signal)).toBe('pending');
      expect(f.ownership()?.mode).toBe('detach-pending');
      expect(f.currentCredential()).toEqual({ token: 'shared-token' });
      expect(f.repo.oauthJournals('oauth-sharing')).toHaveLength(1);
    },
    { shared: true },
  );
});

test('cancelling a suspended detachment fences its late verification result', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      let resolve!: (verified: boolean) => void;
      const verification = new Promise<boolean>((done) => {
        resolve = done;
      });
      f.replaceAdapter({
        ...f.adapter,
        credentialSync: {
          formatVersion: 1,
          multiDevice: { evidenceId: 'fixture-evidence' },
          canDetach: async () => verification,
        },
      });
      const candidate = { ...f.accountWrite, credential: { token: 'independent-token' } };
      const detaching = f.sharing.detach(f.providerId, candidate, f.signal);
      while (f.ownership()?.mode !== 'detach-pending') await Promise.resolve();
      f.sharing.cancelDetach(f.providerId);
      resolve(true);
      expect(await detaching).toBe('pending');
      expect(f.ownership()?.mode).toBe('shared');
      expect(f.currentCredential()).toEqual({ token: 'shared-token' });
      expect(f.repo.oauthJournals('oauth-sharing')).toEqual([]);
    },
    { shared: true },
  );
});

test('verified independent detachment survives a service restart', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      f.replaceAdapter({
        ...f.adapter,
        credentialSync: {
          formatVersion: 1,
          multiDevice: { evidenceId: 'fixture-evidence' },
          canDetach: async () => false,
        },
      });
      const candidate = { ...f.accountWrite, credential: { token: 'independent-token' } };
      expect(await f.sharing.detach(f.providerId, candidate, f.signal)).toBe('pending');
      f.replaceAdapter({
        ...f.adapter,
        credentialSync: {
          formatVersion: 1,
          multiDevice: { evidenceId: 'fixture-evidence' },
          canDetach: async () => true,
        },
      });
      expect(await f.restart().detach(f.providerId, candidate, f.signal)).toBe('independent');
      expect(f.ownership()?.mode).toBe('independent');
      expect(f.currentCredential()).toEqual({ token: 'independent-token' });
    },
    { shared: true },
  );
});

test('cancellation after a service restart removes the durable detach candidate', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      const candidate = { ...f.accountWrite, credential: { token: 'independent-token' } };
      expect(await f.sharing.detach(f.providerId, candidate, f.signal)).toBe('pending');
      f.restart().cancelDetach(f.providerId);
      expect(f.ownership()?.mode).toBe('shared');
      expect(f.currentCredential()).toEqual({ token: 'shared-token' });
      expect(f.repo.oauthJournals('oauth-sharing')).toEqual([]);
    },
    { shared: true },
  );
});

test('first share waits for a local rotation and publishes only the rotated credential', async () => {
  await withOAuthSharingFixture(async (f) => {
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = (await import('./gate')).createOAuthProviderGate();
    const rotating = gate.run(f.providerId, async () => {
      started();
      await waiting;
      const account = f.accounts.readAccount(f.providerId)!;
      const owner = crypto.randomUUID();
      f.accounts.tryAcquireRefreshLease(f.providerId, owner, Date.now(), Date.now() + 1_000);
      f.accounts.compareAndSwapCredential(f.providerId, account.revision, owner, { token: 'rotated-token' });
      f.accounts.releaseRefreshLease(f.providerId, owner);
    });
    await entered;
    const service = (await import('./sharing')).createOAuthSharingService({
      binding: f.repo.readBinding()!,
      repo: f.repo,
      accounts: f.accounts,
      store: (await import('../../publication')).createSyncObjectStore(f.backend.connect()),
      resolveAdapter: () => ({ adapter: f.adapter, pluginVersion: '1.0.0' }),
      withProviderGate: gate.run,
    });
    const sharing = service.share(f.providerId, f.signal);
    release();
    await rotating;
    expect(await sharing).toBe('shared');
    expect(f.remote()?.payload.credential).toEqual({ token: 'rotated-token' });
  });
});

test('first share requires adapter multi-device evidence and preserves local configuration', async () => {
  await withOAuthSharingFixture(async (f) => {
    f.replaceAdapter(oauthAdapterFixture({ credentialSync: { formatVersion: 1 } }));
    expect(await f.sharing.share(f.providerId, f.signal)).toBe('pending');
    expect(f.remote()).toBeNull();
    expect(f.currentCredential()).toEqual({ token: 'shared-token' });
    expect(f.repo.entities('oauth-sharing')[0]?.pendingReason).toBe('pending-plugin-update');
  });
});

test('first share reconciles an acknowledged write whose response was lost', async () => {
  await withOAuthSharingFixture(async (f) => {
    f.backend.failNext('compareAndSwap', 'after');
    expect(await f.sharing.share(f.providerId, f.signal)).toBe('shared');
    expect(f.ownership()).toMatchObject({ mode: 'shared', epoch: 0, generation: 0 });
    expect(f.repo.oauthJournals('oauth-sharing')).toEqual([]);
  });
});

test('shared replacement recovers an acknowledged CAS without rotating twice', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      const candidate = { ...f.accountWrite, credential: { token: 'replacement-token' } };
      f.backend.failNext('compareAndSwap', 'after');
      await expect(f.sharing.replaceShared(f.providerId, candidate, f.signal)).rejects.toThrow();
      expect(f.remote()).toMatchObject({ epoch: 0, generation: 1, pluginVersion: '1.0.0', formatVersion: 1 });
      await f.restart().replaceShared(f.providerId, candidate, f.signal);
      expect(f.remote()).toMatchObject({ epoch: 0, generation: 1 });
      expect(f.currentCredential()).toEqual({ token: 'replacement-token' });
      expect(f.ownership()).toMatchObject({ mode: 'shared', epoch: 0, generation: 1 });
      expect(f.repo.oauthJournals('oauth-sharing')).toEqual([]);
    },
    { shared: true },
  );
});

test('an incompatible existing remote account remains read-only', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      f.replaceAdapter({
        ...f.adapter,
        credentialSync: {
          formatVersion: 2,
          multiDevice: { evidenceId: 'fixture-evidence-v2' },
          canDetach: async () => true,
        },
      });
      expect(await f.sharing.share(f.providerId, f.signal)).toBe('pending');
      expect(f.remote()).toMatchObject({ formatVersion: 1, generation: 0 });
      expect(f.repo.entities('oauth-sharing')[0]?.pendingReason).toBe('pending-plugin-update');
    },
    { shared: true },
  );
});

test('an ownership change while canDetach is pending fences the candidate commit', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      let resolve!: (verified: boolean) => void;
      const verification = new Promise<boolean>((done) => {
        resolve = done;
      });
      f.replaceAdapter({
        ...f.adapter,
        credentialSync: {
          formatVersion: 1,
          multiDevice: { evidenceId: 'fixture-evidence' },
          canDetach: async () => verification,
        },
      });
      const candidate = { ...f.accountWrite, credential: { token: 'independent-token' } };
      const detaching = f.sharing.detach(f.providerId, candidate, f.signal);
      while (f.ownership()?.mode !== 'detach-pending') await Promise.resolve();
      const entity = f.repo.entities('oauth-sharing')[0]!;
      f.repo.putEntity('oauth-sharing', {
        ...entity,
        oauth: { ...entity.oauth!, mode: 'shared', generation: 1 },
      });
      resolve(true);
      expect(await detaching).toBe('pending');
      expect(f.currentCredential()).toEqual({ token: 'shared-token' });
    },
    { shared: true },
  );
});

test('an active remote refresh claim blocks detachment and replacement', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      const stored = f.backend.readAll().get(`s/v1/default/account/${f.objectId}`);
      if (stored?.kind !== 'present') throw new Error('missing remote fixture');
      const remote = JSON.parse(new TextDecoder().decode(stored.value));
      remote.phase = 'refreshing';
      remote.claim = { operationId: 'active-refresh', ownerDeviceId: 'other-device', baseGeneration: 0 };
      const session = f.backend.connect();
      await session.compareAndSwap(
        `s/v1/default/account/${f.objectId}`,
        stored.version,
        new TextEncoder().encode(JSON.stringify(remote)),
        f.signal,
      );
      await session.dispose();
      let detachChecks = 0;
      f.replaceAdapter({
        ...f.adapter,
        credentialSync: {
          formatVersion: 1,
          multiDevice: { evidenceId: 'fixture-evidence' },
          canDetach: async () => {
            detachChecks++;
            return true;
          },
        },
      });
      const candidate = { ...f.accountWrite, credential: { token: 'new-login' } };
      expect(await f.sharing.detach(f.providerId, candidate, f.signal)).toBe('pending');
      expect(detachChecks).toBe(0);
      await expect(f.sharing.replaceShared(f.providerId, candidate, f.signal)).rejects.toThrow(
        'SYNC_OAUTH_REPLACEMENT_PENDING',
      );
      expect(f.remote()).toMatchObject({ phase: 'refreshing', generation: 0 });
    },
    { shared: true },
  );
});

test('a purged shared remote never falls back to the retained local credential', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      const remote = f.backend.readAll().get(`s/v1/default/account/${f.objectId}`);
      if (remote?.kind !== 'present') throw new Error('missing remote fixture');
      const session = f.backend.connect();
      await session.remove(`s/v1/default/account/${f.objectId}`, remote.version, f.signal);
      await session.dispose();
      const candidate = { ...f.accountWrite, credential: { token: 'independent-token' } };
      expect(await f.sharing.detach(f.providerId, candidate, f.signal)).toBe('pending');
      expect(f.currentCredential()).toEqual({ token: 'shared-token' });
      expect(f.ownership()?.mode).toBe('shared');
    },
    { shared: true },
  );
});

test('a backend switch never seeds an already-shared credential into an empty space', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      const value = f.backend.readAll().get(`s/v1/default/account/${f.objectId}`);
      expect(value?.kind).toBe('present');
      const emptyBackend = (await import('../../test-support')).createMemorySyncBackend();
      const switched = { ...f.repo.readBinding()!, id: 'second-binding', identityId: 'second-identity' };
      f.repo.writeBinding(switched);
      const { oauth: _oldOwnership, ...entity } = f.repo.entities('oauth-sharing')[0]!;
      f.repo.putEntity(switched.id, { ...entity, objectId: crypto.randomUUID() });
      const service = (await import('./sharing')).createOAuthSharingService({
        binding: switched,
        repo: f.repo,
        accounts: f.accounts,
        store: (await import('../../publication')).createSyncObjectStore(emptyBackend.connect()),
        resolveAdapter: () => ({ adapter: f.adapter, pluginVersion: '1.0.0' }),
        withProviderGate: async (_providerId, run) => run(),
      });
      expect(await service.share(f.providerId, f.signal)).toBe('pending');
      expect(emptyBackend.readAll()).toHaveLength(0);
    },
    { shared: true },
  );
});

test('an unconfirmed first share durably fences local ownership before returning pending', async () => {
  await withOAuthSharingFixture(async (f) => {
    const session = f.backend.connect();
    let published = false;
    const service = (await import('./sharing')).createOAuthSharingService({
      binding: f.repo.readBinding()!,
      repo: f.repo,
      accounts: f.accounts,
      store: (await import('../../publication')).createSyncObjectStore({
        ...session,
        async compareAndSwap(...args) {
          await session.compareAndSwap(...args);
          published = true;
          throw new (await import('@aio-proxy/plugin-sdk')).SyncBackendError('outcome-unknown');
        },
        async read(...args) {
          if (published) return { kind: 'absent' };
          return session.read(...args);
        },
      }),
      resolveAdapter: () => ({ adapter: f.adapter, pluginVersion: '1.0.0' }),
      withProviderGate: async (_id, run) => run(),
    });
    expect(await service.share(f.providerId, f.signal)).toBe('pending');
    expect(f.remote()?.payload.credential).toEqual({ token: 'shared-token' });
    expect(f.ownership()?.mode).toBe('share-pending');
    expect(f.repo.oauthJournals('oauth-sharing')).toHaveLength(1);
    await f.restart().recover(f.signal);
    expect(f.ownership()?.mode).toBe('shared');
  });
});

test('startup revalidates established ownership after adapter evidence is removed', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      f.replaceAdapter(oauthAdapterFixture());
      await f.restart().recover(f.signal);
      expect(f.repo.entities('oauth-sharing')[0]?.pendingReason).toBe('pending-plugin-update');
      expect(f.remote()?.generation).toBe(0);
    },
    { shared: true },
  );
});

test('a previously attempted first share never republishes after the remote account disappears', async () => {
  await withOAuthSharingFixture(async (f) => {
    f.backend.failNext('compareAndSwap', 'before');
    await expect(f.sharing.share(f.providerId, f.signal)).rejects.toThrow();
    await f.restart().recover(f.signal);
    expect(f.remote()).toBeNull();
    expect(f.ownership()?.mode).toBe('share-pending');
  });
});

test.each(['generation', 'identity', 'claim', 'credential'])(
  'first share rejects a conflicting remote %s without overwriting it',
  async (field) => {
    await withOAuthSharingFixture(async (f) => {
      const remote = (await import('../test-support')).liveAccountFixture({
        payload: {
          credential: { token: 'shared-token' },
          fingerprint: 'fixture',
          options: {},
          secrets: {},
        },
      });
      if (field === 'generation') remote.generation = 1;
      if (field === 'identity') remote.objectId = 'other-object';
      if (field === 'claim') remote.claim = { operationId: 'rotation', ownerDeviceId: 'other', baseGeneration: 0 };
      if (field === 'credential') remote.payload.credential = { token: 'other-token' };
      const session = f.backend.connect();
      const key = `s/v1/default/account/${f.objectId}`;
      await session.compareAndSwap(key, null, new TextEncoder().encode(JSON.stringify(remote)), f.signal);
      expect(await f.sharing.share(f.providerId, f.signal)).toBe('pending');
      expect(f.remote()).toEqual(remote);
      expect(f.ownership()?.mode).toBe('share-pending');
    });
  },
);

test('verified detachment from the old binding allows an independent credential in the new binding', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      f.replaceAdapter({ ...f.adapter, credentialSync: { ...f.adapter.credentialSync!, canDetach: async () => true } });
      expect(
        await f.sharing.detach(f.providerId, { ...f.accountWrite, credential: { token: 'independent' } }, f.signal),
      ).toBe('independent');
      const switched = { ...f.repo.readBinding()!, id: 'second', identityId: 'second-identity' };
      f.repo.writeBinding(switched);
      const { oauth: _old, ...entity } = f.repo.entities('oauth-sharing')[0]!;
      f.repo.putEntity(switched.id, { ...entity, objectId: crypto.randomUUID() });
      const backend = (await import('../../test-support')).createMemorySyncBackend();
      const service = (await import('./sharing')).createOAuthSharingService({
        binding: switched,
        repo: f.repo,
        accounts: f.accounts,
        store: (await import('../../publication')).createSyncObjectStore(backend.connect()),
        resolveAdapter: () => ({ adapter: f.adapter, pluginVersion: '1.0.0' }),
        withProviderGate: async (_id, run) => run(),
      });
      expect(await service.share(f.providerId, f.signal)).toBe('shared');
      expect(f.remote()?.payload.credential).toEqual({ token: 'shared-token' });
      expect(f.currentCredential()).toEqual({ token: 'independent' });
    },
    { shared: true },
  );
});

test('invalid login credentials cannot be published or committed by detachment', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      const candidate = { ...f.accountWrite, credential: { token: 123 } };
      await expect(f.sharing.replaceShared(f.providerId, candidate, f.signal)).rejects.toThrow(
        'SYNC_OAUTH_UPGRADE_REQUIRED',
      );
      expect(await f.sharing.detach(f.providerId, candidate, f.signal)).toBe('pending');
      expect(f.currentCredential()).toEqual({ token: 'shared-token' });
      expect(f.remote()?.generation).toBe(0);
    },
    { shared: true },
  );
});
