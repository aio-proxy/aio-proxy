import { expect, test } from 'bun:test';

import { zod } from '@aio-proxy/plugin-sdk';

import { retainsSharedOAuth } from '../protocol';
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

// `canDetach` reaches the OAuth service, so it can fail rather than answer. The pending row is
// durable by then and blocks every read of the shared credential; the caller reports the error
// without knowing a detachment was started, and recovery would rethrow on each restart.
test('a verification that throws leaves the Provider shared rather than blocked', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      f.replaceAdapter({
        ...f.adapter,
        credentialSync: {
          formatVersion: 1,
          multiDevice: { evidenceId: 'fixture-evidence' },
          canDetach: () => Promise.reject(new Error('oauth service offline')),
        },
      });
      const candidate = { ...f.accountWrite, credential: { token: 'independent-token' } };
      await expect(f.sharing.detach(f.providerId, candidate, f.signal)).rejects.toThrow('oauth service offline');
      expect(f.ownership()?.mode).toBe('shared');
      expect(f.currentCredential()).toEqual({ token: 'shared-token' });
      expect(f.repo.oauthJournals('oauth-sharing')).toEqual([]);
    },
    { shared: true },
  );
});

test('cancelling a detachment that has not journalled yet leaves the Provider shared', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      let admit!: () => void;
      let validating!: () => void;
      const held = new Promise<void>((resolve) => {
        admit = resolve;
      });
      const reached = new Promise<void>((resolve) => {
        validating = resolve;
      });
      f.replaceAdapter({
        ...f.adapter,
        // Suspends the detachment in adapter validation, before it journals anything.
        credentials: zod.object({ token: zod.string() }).refine(async () => {
          validating();
          await held;
          return true;
        }),
        credentialSync: {
          formatVersion: 1,
          multiDevice: { evidenceId: 'fixture-evidence' },
          canDetach: async () => true,
        },
      });
      const candidate = { ...f.accountWrite, credential: { token: 'independent-token' } };
      const detaching = f.sharing.detach(f.providerId, candidate, f.signal);
      await reached;
      f.sharing.cancelDetach(f.providerId);
      admit();

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

test('first share supersedes a tombstone left at the account key by a restore', async () => {
  await withOAuthSharingFixture(async (f) => {
    const key = `s/v1/default/account/${f.objectId}`;
    const session = f.backend.connect();
    // What `ensureAccountActiveFence` leaves behind: the key is present, so compare-and-swapping
    // against an absent key can never write and sharing would stall on `pending` for good.
    await session.compareAndSwap(
      key,
      null,
      new TextEncoder().encode(JSON.stringify({ protocol: 1, phase: 'deleted', objectId: f.objectId, epoch: 1 })),
      f.signal,
    );
    await session.dispose();

    expect(await f.sharing.share(f.providerId, f.signal)).toBe('shared');
    expect(f.remote()).toMatchObject({ epoch: 1, generation: 0, phase: 'ready' });
    expect(f.ownership()).toMatchObject({ mode: 'shared', epoch: 1 });
    expect(f.repo.oauthJournals('oauth-sharing')).toEqual([]);
  });
});

test('an excluded Provider is never shared by startup recovery or by a later login', async () => {
  await withOAuthSharingFixture(async (f) => {
    const entity = f.repo.entities('oauth-sharing').find((row) => row.logicalKey === f.providerId)!;
    f.repo.putEntity('oauth-sharing', { ...entity, mode: 'excluded' });

    await f.sharing.recover(f.signal);
    await f.sharing.synchronizeLogin(f.providerId, f.accountWrite, f.signal);

    // The user declined to put this Provider in the cloud, so neither path may upload its credential.
    expect(f.remote()).toBeNull();
    expect(f.ownership()).toBeUndefined();
    expect(f.repo.oauthJournals('oauth-sharing')).toEqual([]);
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

test('a replacement journal another device moved past is retired instead of replayed forever', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      const candidate = { ...f.accountWrite, credential: { token: 'replacement-token' } };
      f.backend.failNext('compareAndSwap', 'before');
      await expect(f.sharing.replaceShared(f.providerId, candidate, f.signal)).rejects.toThrow();
      expect(f.repo.oauthJournals('oauth-sharing')).toHaveLength(1);
      const stored = f.backend.readAll().get(`s/v1/default/account/${f.objectId}`);
      if (stored?.kind !== 'present') throw new Error('missing remote fixture');
      const remote = JSON.parse(new TextDecoder().decode(stored.value));
      remote.generation = 7;
      const session = f.backend.connect();
      await session.compareAndSwap(
        `s/v1/default/account/${f.objectId}`,
        stored.version,
        new TextEncoder().encode(JSON.stringify(remote)),
        f.signal,
      );
      await session.dispose();

      // The journaled CAS can never apply against this space again, so the row has to go: keeping it
      // would replay the same conflict on every login and hold the Provider shared forever.
      await expect(f.sharing.replaceShared(f.providerId, candidate, f.signal)).rejects.toThrow(
        'SYNC_OAUTH_REPLACEMENT_CONFLICT',
      );
      expect(f.repo.oauthJournals('oauth-sharing')).toEqual([]);
      expect(f.remote()).toMatchObject({ generation: 7 });
      await expect(f.sharing.replaceShared(f.providerId, candidate, f.signal)).rejects.toThrow(
        'SYNC_OAUTH_REPLACEMENT_PENDING',
      );
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

test('a fresh login replaces a shared account an abandoned refresh left uncertain', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      const stored = f.backend.readAll().get(`s/v1/default/account/${f.objectId}`);
      if (stored?.kind !== 'present') throw new Error('missing remote fixture');
      const remote = JSON.parse(new TextDecoder().decode(stored.value));
      remote.phase = 'uncertain';
      remote.claim = { operationId: 'abandoned-refresh', ownerDeviceId: 'this-device', baseGeneration: 0 };
      const session = f.backend.connect();
      await session.compareAndSwap(
        `s/v1/default/account/${f.objectId}`,
        stored.version,
        new TextEncoder().encode(JSON.stringify(remote)),
        f.signal,
      );
      await session.dispose();
      const candidate = { ...f.accountWrite, credential: { token: 'new-login' } };

      await f.sharing.replaceShared(f.providerId, candidate, f.signal);

      // The new epoch is what makes a late result from the abandoned exchange fail rather than
      // resurrect the credential this login just retired.
      expect(f.remote()).toMatchObject({ phase: 'ready', claim: null, epoch: 1, generation: 1 });
      expect(f.currentCredential()).toEqual({ token: 'new-login' });
      expect(f.ownership()).toMatchObject({ mode: 'shared', epoch: 1, generation: 1 });
      expect(f.repo.oauthJournals('oauth-sharing')).toEqual([]);
    },
    { shared: true },
  );
});

test('a fresh login replaces a shared account a rejected refresh result quarantined', async () => {
  await withOAuthSharingFixture(
    async (f) => {
      const coordinator = (await import('../coordinator')).createSharedOAuthCoordinator({
        binding: f.repo.readBinding()!,
        store: (await import('../../publication')).createSyncObjectStore(f.backend.connect()),
        repo: f.repo,
      });
      const schema = zod.object({ token: zod.string() });
      await expect(
        coordinator.refresh(
          {
            objectId: f.objectId,
            epoch: 0,
            generation: 0,
            exchange: async () => ({ value: { revoked: true } }),
            validate: async (value: unknown) => schema.parse(value),
          },
          f.signal,
        ),
      ).rejects.toMatchObject({ code: 'unverified' });
      expect(f.remote()).toMatchObject({ phase: 'login-required', epoch: 0, generation: 0 });

      const candidate = { ...f.accountWrite, credential: { token: 'new-login' } };
      await f.sharing.synchronizeLogin(f.providerId, candidate, f.signal);

      expect(f.remote()).toMatchObject({ phase: 'ready', claim: null, epoch: 1, generation: 1 });
      expect(f.currentCredential()).toEqual({ token: 'new-login' });
      expect(f.ownership()).toMatchObject({ mode: 'shared', epoch: 1, generation: 1 });
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

// The account write and the transaction that records it are separate, so between them the journal
// and `share-pending` ownership stand over a credential other devices can already be following.
// Read as an unstarted share, disconnect retires the binding and nothing can target the ownership
// again — leaving the local port free to rotate a refresh token those devices still use.
test('a first share whose write has landed holds the binding until the local record catches up', async () => {
  await withOAuthSharingFixture(async (f) => {
    const session = f.backend.connect();
    let landed!: () => void;
    const written = new Promise<void>((resolve) => {
      landed = resolve;
    });
    const service = (await import('./sharing')).createOAuthSharingService({
      binding: f.repo.readBinding()!,
      repo: f.repo,
      accounts: f.accounts,
      store: (await import('../../publication')).createSyncObjectStore({
        ...session,
        async compareAndSwap(...args) {
          const result = await session.compareAndSwap(...args);
          landed();
          // Stands in for the process exiting here: the write is durable in the backend, the local
          // transaction that would clear the journal has not run.
          await new Promise(() => {});
          return result;
        },
      }),
      resolveAdapter: () => ({ adapter: f.adapter, pluginVersion: '1.0.0' }),
      withProviderGate: async (_id, run) => run(),
    });
    void service.share(f.providerId, f.signal);
    await written;

    expect(f.remote()?.payload.credential).toEqual({ token: 'shared-token' });
    expect(f.ownership()?.mode).toBe('share-pending');
    const entity = f.repo.entities('oauth-sharing')[0]!;
    expect(retainsSharedOAuth(entity, f.repo.oauthJournals('oauth-sharing'))).toBe(true);
    // Recovery is still the resolution: it finds the published account and completes the record.
    await f.restart().recover(f.signal);
    expect(f.ownership()?.mode).toBe('shared');
    expect(f.repo.oauthJournals('oauth-sharing')).toEqual([]);
  });
});

// Disconnect refuses to retire a binding whose rows hold a shared credential, then retires it. A
// share suspended past its own binding check must not land a hold after that: ownership would name
// an account object in a space no later detach can reach, and every later binding would refuse the
// Provider as `detach-pending` with nothing able to clear it.
test('a share suspended past the disconnect check writes no hold onto the retired binding', async () => {
  await withOAuthSharingFixture(async (f) => {
    let admit!: () => void;
    let validating!: () => void;
    const held = new Promise<void>((resolve) => {
      admit = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      validating = resolve;
    });
    f.replaceAdapter({
      ...f.adapter,
      credentials: zod.object({ token: zod.string() }).refine(async () => {
        validating();
        await held;
        return true;
      }),
    });
    const sharing = f.sharing.share(f.providerId, f.signal);
    await reached;
    const entity = f.repo.entities('oauth-sharing')[0]!;
    expect(retainsSharedOAuth(entity, f.repo.oauthJournals('oauth-sharing'))).toBe(false);
    f.repo.clearBinding!();
    admit();

    expect(await sharing).toBe('pending');
    expect(f.remote()).toBeNull();
    expect(f.ownership()).toBeUndefined();
    expect(f.repo.oauthJournals('oauth-sharing')).toEqual([]);
  });
});

// Every built-in adapter ships `credentialSync: { formatVersion: 1 }` and nothing else: the
// multi-device evidence and the `canDetach` check that goes with it are added per adapter once live
// runs pass. Sharing one of those before then would publish a credential the device can never prove
// itself independent of, and a shared row refuses both disconnect and backend replacement.
test('an adapter without recorded multi-device evidence never reaches shared ownership', async () => {
  await withOAuthSharingFixture(async (f) => {
    f.replaceAdapter({ ...f.adapter, credentialSync: { formatVersion: 1 } });

    expect(await f.sharing.share(f.providerId, f.signal)).toBe('pending');
    expect(f.remote()).toBeNull();
    expect(f.ownership()).toBeUndefined();
    expect(retainsSharedOAuth(f.repo.entities('oauth-sharing')[0]!, f.repo.oauthJournals('oauth-sharing'))).toBe(false);
  });
});
