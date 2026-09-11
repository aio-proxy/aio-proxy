import { expect, test } from 'bun:test';

import { deleteEntity } from '../cleanup';
import { encode, newHead, entityKey, revisionKey, type EntityBody } from '../protocol';
import { createSyncObjectStore, publishEntity } from '../publication';
import { withTwoSyncDevices } from '../test-support';
import { MAX_BACKOFF_MS, nextBackoffMs } from './scheduler';

test('a cloud Provider joins the other device and import has no outgoing echo', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: 'k' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((e) => e.logicalKey === 'work')?.mode).toBe('included');
    expect(b.repo.outbox(b.binding.id)).toEqual([]);
  });
});

test('remote updates, pending states, and deletion preserve OAuth ownership', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    const ownership = {
      mode: 'shared' as const,
      epoch: 0,
      generation: 2,
      localRevision: 4,
      pluginVersion: '1.0.0',
      formatVersion: 1,
    };
    b.repo.putEntity(b.binding.id, {
      objectId: 'provider-work',
      logicalKey: 'work',
      kind: 'provider',
      mode: 'included',
      epoch: 0,
      desired: null,
      baseline: null,
      overrides: [],
      pendingReason: null,
      oauth: ownership,
    });
    await a.commitProvider('work', { kind: 'api', apiKey: 'first' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-work')?.oauth).toEqual(
      ownership,
    );

    await a.commitProvider('work', { kind: 'api', apiKey: 'second' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-work')?.oauth).toEqual(
      ownership,
    );

    b.setPendingActivation('missing-plugin');
    await a.commitProvider('work', { kind: 'api', apiKey: 'third' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-work')).toMatchObject({
      pendingReason: 'missing-plugin',
      oauth: ownership,
    });

    b.setPendingActivation(undefined);
    await a.commitProvider('work', { kind: 'api', apiKey: 'fourth' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);
    await deleteEntity(createSyncObjectStore(a.session), 'provider-work', 0, a.signal);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-work')).toMatchObject({
      baseline: expect.stringMatching(/^deleted:/),
      oauth: ownership,
    });
  });
});

test('a locally excluded Provider stays excluded when discovered from the cloud', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    await b.commitProvider('work', { kind: 'api', apiKey: 'local' }, false);
    await a.commitProvider('work', { kind: 'api', apiKey: 'shared' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((e) => e.logicalKey === 'work')).toMatchObject({
      mode: 'excluded',
      pendingReason: null,
    });
    expect(b.repo.outbox(b.binding.id)).toEqual([]);
  });
});

test('start polls and applies a cloud change without a manual reconcile', async () => {
  await withTwoSyncDevices(
    async ({ a, b }) => {
      b.engine.start();
      const applied = b.waitForRemoteApply('provider-work');
      await a.commitProvider('work', { kind: 'api', apiKey: 'k' }, true);
      await a.engine.reconcile(a.signal);
      await applied;
      await Promise.resolve();
      expect(b.repo.entities(b.binding.id).find((e) => e.logicalKey === 'work')?.mode).toBe('included');
    },
    { watch: false },
  );
});

test('polling retries after offline and quota failures without watch hints', async () => {
  for (const code of ['offline', 'quota'] as const) {
    await withTwoSyncDevices(
      async ({ a, b }) => {
        await a.commitProvider('work', { kind: 'api', apiKey: code }, true);
        await a.engine.reconcile(a.signal);
        b.failNext('read', 'before', code);
        const failed = b.waitForStatus(code);
        b.engine.start();
        await failed;
        const applied = b.waitForRemoteApply('provider-work');
        const online = b.waitForStatus('online');
        await Promise.all([applied, online]);
        await Promise.resolve();
        expect(b.repo.entities(b.binding.id).find((e) => e.logicalKey === 'work')?.mode).toBe('included');
      },
      { watch: false },
    );
  }
});

test('an active head without a current revision remains transient during reconciliation', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    const body: EntityBody = {
      kind: 'provider',
      logicalKey: 'transient',
      value: { kind: 'api' },
      dependencies: [],
    };
    await a.session.compareAndSwap(
      entityKey('provider-transient'),
      null,
      encode(newHead('provider-transient', body)),
      a.signal,
    );
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id)).toEqual([]);
  });
});

test('conflicting cloud object IDs are all excluded before any provider is applied', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    const signal = a.signal;
    const store = createSyncObjectStore(a.session);
    await publishEntity(
      store,
      {
        operationId: 'conflict-a-op',
        objectId: 'provider-conflict-a',
        epoch: 0,
        kind: 'put',
        body: { kind: 'provider', logicalKey: 'conflict', value: { kind: 'api', key: 'a' }, dependencies: [] },
        commitId: 'fixture-a',
      },
      signal,
    );
    await publishEntity(
      store,
      {
        operationId: 'conflict-b-op',
        objectId: 'provider-conflict-b',
        epoch: 0,
        kind: 'put',
        body: { kind: 'provider', logicalKey: 'conflict', value: { kind: 'api', key: 'b' }, dependencies: [] },
        commitId: 'fixture-b',
      },
      signal,
    );
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id)).toEqual([
      expect.objectContaining({
        objectId: 'provider-conflict-a',
        mode: 'excluded',
        pendingReason: 'provider-id-conflict',
      }),
      expect.objectContaining({
        objectId: 'provider-conflict-b',
        mode: 'excluded',
        pendingReason: 'provider-id-conflict',
      }),
    ]);
  });
});

test('a late colliding cloud object quarantines both identities without deleting the active Provider', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: 'shared' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((e) => e.logicalKey === 'work')?.mode).toBe('included');
    await publishEntity(
      createSyncObjectStore(a.session),
      {
        operationId: 'collision-op',
        objectId: 'provider-collision',
        epoch: 0,
        kind: 'put',
        body: { kind: 'provider', logicalKey: 'work', value: { kind: 'api', apiKey: 'other' }, dependencies: [] },
        commitId: 'fixture-collision',
      },
      a.signal,
    );

    await b.engine.reconcile(b.signal);

    expect(b.remoteApplyCalls().some((call) => call.body === null)).toBe(false);
    expect(
      b.repo
        .entities(b.binding.id)
        .filter((entity) => entity.logicalKey === 'work')
        .map((entity) => [entity.mode, entity.pendingReason]),
    ).toEqual([
      ['excluded', 'provider-id-conflict'],
      ['excluded', 'provider-id-conflict'],
    ]);
  });
});

test('a tombstoned row does not collide with the object that takes over its Provider ID', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: 'shared' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);
    await deleteEntity(createSyncObjectStore(a.session), 'provider-work', 0, a.signal);
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((e) => e.objectId === 'provider-work')?.desired).toBeNull();
    await publishEntity(
      createSyncObjectStore(a.session),
      {
        operationId: 'recreated-op',
        objectId: 'provider-recreated',
        epoch: 0,
        kind: 'put',
        body: { kind: 'provider', logicalKey: 'work', value: { kind: 'api', apiKey: 'again' }, dependencies: [] },
        commitId: 'fixture-recreated',
      },
      a.signal,
    );

    await b.engine.reconcile(b.signal);

    expect(b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-recreated')).toMatchObject({
      mode: 'included',
      pendingReason: null,
    });
  });
});

test('watch hints coalesce while one remote application is in flight', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    const gate = b.pauseRemoteApplication();
    b.engine.start();
    await a.commitProvider('work', { kind: 'api', apiKey: 'k' }, true);
    await a.engine.reconcile(a.signal);
    await gate.entered;
    const otherApplied = b.waitForRemoteApply('provider-other');
    await a.commitProvider('other', { kind: 'api', apiKey: 'other' }, true);
    await a.engine.reconcile(a.signal);
    gate.release();
    await otherApplied;
    expect(b.remoteApplyCalls().filter((call) => call.objectId === 'provider-work')).toHaveLength(1);
  });
});

test('a pending dependency is retried and activates after the dependency becomes available', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: 'k' }, true);
    await a.engine.reconcile(a.signal);
    b.setPendingActivation('missing-plugin');
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((e) => e.logicalKey === 'work')).toMatchObject({
      pendingReason: 'missing-plugin',
      baseline: null,
    });
    b.setPendingActivation(undefined);
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((e) => e.logicalKey === 'work')).toMatchObject({
      pendingReason: null,
      baseline: expect.any(String),
    });
  });
});

test('unknown protocol data remains read-only and marks an existing identity upgrade-required', async () => {
  await withTwoSyncDevices(async ({ b }) => {
    b.repo.putEntity(b.binding.id, {
      objectId: 'provider-unknown',
      logicalKey: 'unknown',
      kind: 'provider',
      mode: 'included',
      epoch: 0,
      desired: null,
      baseline: null,
      overrides: [],
      pendingReason: null,
    });
    await b.session.compareAndSwap(
      entityKey('provider-unknown'),
      null,
      new Uint8Array([123, 34, 112, 114, 111, 116, 111, 99, 111, 108, 34, 58, 50, 125]),
      b.signal,
    );
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((e) => e.objectId === 'provider-unknown')).toMatchObject({
      pendingReason: 'upgrade-required',
      baseline: null,
    });
  });
});

test('a current revision with mismatched identity never becomes a baseline', async () => {
  await withTwoSyncDevices(async ({ b }) => {
    const body: EntityBody = {
      kind: 'provider',
      logicalKey: 'mismatch',
      value: { kind: 'api' },
      dependencies: [],
    };
    b.repo.putEntity(b.binding.id, {
      objectId: 'provider-mismatch',
      logicalKey: 'mismatch',
      kind: 'provider',
      mode: 'included',
      epoch: 0,
      desired: null,
      baseline: null,
      overrides: [],
      pendingReason: null,
    });
    await b.session.compareAndSwap(
      entityKey('provider-mismatch'),
      null,
      encode({ ...newHead('provider-mismatch', body), current: 'wrong-operation', sequence: 1 }),
      b.signal,
    );
    await b.session.compareAndSwap(
      revisionKey('provider-mismatch', 'wrong-operation'),
      null,
      encode({
        protocol: 1,
        state: 'payload',
        objectId: 'other-object',
        epoch: 0,
        operationId: 'wrong-operation',
        body,
        publishedSequence: 1,
        writtenAt: 1,
      }),
      b.signal,
    );
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((e) => e.objectId === 'provider-mismatch')).toMatchObject({
      baseline: null,
      pendingReason: 'invalid-config',
    });
  });
});

test('a head stored under a different object key remains read-only during remote listing', async () => {
  await withTwoSyncDevices(async ({ b }) => {
    b.repo.putEntity(b.binding.id, {
      objectId: 'provider-keyed',
      logicalKey: 'keyed',
      kind: 'provider',
      mode: 'included',
      epoch: 0,
      desired: null,
      baseline: null,
      overrides: [],
      pendingReason: null,
    });
    await b.session.compareAndSwap(
      entityKey('provider-keyed'),
      null,
      encode(
        newHead('other-object', {
          kind: 'provider',
          logicalKey: 'keyed',
          value: { kind: 'api' },
          dependencies: [],
        }),
      ),
      b.signal,
    );
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-keyed')).toMatchObject({
      baseline: null,
      pendingReason: 'invalid-config',
    });
  });
});

test('excluded identities receive cloud deletion signals', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    await b.commitProvider('work', { kind: 'api', apiKey: 'local' }, false);
    await a.commitProvider('work', { kind: 'api', apiKey: 'shared' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);
    await deleteEntity(createSyncObjectStore(a.session), 'provider-work', 0, a.signal);
    await b.engine.reconcile(b.signal);
    expect(b.remoteApplyCalls().some((call) => call.objectId === 'provider-work' && call.body === null)).toBe(true);
    expect(b.repo.entities(b.binding.id).find((e) => e.logicalKey === 'work')?.desired).toBeNull();
  });
});

test('an exclusion landing during a remote application is not overwritten by the snapshot mode', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: 'first' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);
    await a.commitProvider('work', { kind: 'api', apiKey: 'second' }, true);
    await a.engine.reconcile(a.signal);

    const gate = b.pauseRemoteApplication();
    const pending = b.engine.reconcile(b.signal);
    await gate.entered;
    const row = b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-work');
    b.repo.putEntity(b.binding.id, { ...row!, mode: 'excluded' });
    gate.release();
    await pending;

    expect(b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-work')).toMatchObject({
      mode: 'excluded',
    });
  });
});

test('a queued put is dropped instead of resurrecting a remotely deleted head', async () => {
  await withTwoSyncDevices(async ({ a }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: 'first' }, true);
    await a.engine.reconcile(a.signal);
    expect(a.repo.outbox(a.binding.id)).toEqual([]);
    await deleteEntity(createSyncObjectStore(a.session), 'provider-work', 0, a.signal);
    await a.commitProvider('work', { kind: 'api', apiKey: 'restored' }, true);
    await a.engine.reconcile(a.signal);
    expect(a.repo.outbox(a.binding.id)).toEqual([]);
    // The tombstone survives the stale write, and the deletion is what reconciliation applies
    // locally. Bringing the configuration back is only possible through an explicit restore.
    const head = await createSyncObjectStore(a.session).readHead('provider-work', a.signal);
    expect(head?.head.state).toBe('deleted');
    expect(head?.head.epoch).toBe(0);
    expect(a.remoteApplyCalls().some((call) => call.objectId === 'provider-work' && call.body === null)).toBe(true);
  });
});

test('a local delete outbox operation is published and acknowledged', async () => {
  await withTwoSyncDevices(async ({ a }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: 'first' }, true);
    await a.engine.reconcile(a.signal);
    a.queueDelete('provider-work', 0);
    await a.engine.reconcile(a.signal);
    expect(a.repo.outbox(a.binding.id)).toEqual([]);
    expect((await createSyncObjectStore(a.session).readHead('provider-work', a.signal))?.head.state).toBe('deleted');
  });
});

test('removing a published provider from authored config captures and publishes a delete', async () => {
  await withTwoSyncDevices(async ({ a }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: 'first' }, true);
    await a.engine.reconcile(a.signal);
    await a.removeProvider('work');
    expect(a.repo.outbox(a.binding.id)).toContainEqual(
      expect.objectContaining({ objectId: 'provider-work', kind: 'delete', body: null }),
    );
    await a.engine.reconcile(a.signal);
    expect(a.repo.outbox(a.binding.id)).toEqual([]);
    expect((await createSyncObjectStore(a.session).readHead('provider-work', a.signal))?.head.state).toBe('deleted');
  });
});

test('stale callbacks cannot persist state after the binding generation switches', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: 'k' }, true);
    await a.engine.reconcile(a.signal);
    const gate = b.pauseRemoteApplication();
    const pending = b.engine.reconcile(b.signal);
    await gate.entered;
    b.repo.writeBinding({ ...b.binding, sessionGeneration: 2 });
    gate.release();
    await pending;
    expect(b.repo.entities(b.binding.id)).toEqual([]);
  });
});

test('binding generation switches during local commit recovery leave the pending intent untouched', async () => {
  await withTwoSyncDevices(async ({ b }) => {
    await b.preparePendingProvider('work', { kind: 'api', apiKey: 'k' });
    const gate = b.pauseLocalDigest();
    const pending = b.engine.reconcile(b.signal);
    await gate.entered;
    b.repo.writeBinding({ ...b.binding, sessionGeneration: 2 });
    gate.release();
    await pending;
    expect(b.repo.pendingCommits(b.binding.id)).toHaveLength(1);
    expect(b.repo.outbox(b.binding.id)).toEqual([]);
  });
});

test('stop aborts in-flight work, disposes once, and is repeatable', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: 'k' }, true);
    await a.engine.reconcile(a.signal);
    const gate = b.gateNext('read');
    const pending = b.engine.reconcile(b.signal);
    await gate.entered;
    const firstStop = b.engine.stop();
    const secondStop = b.engine.stop();
    gate.release();
    await Promise.all([pending, firstStop, secondStop]);
    await b.engine.stop();
  });
});

test('stop remains successful when session disposal fails', async () => {
  await withTwoSyncDevices(async ({ b }) => {
    b.session.dispose = async () => {
      throw new Error('dispose failed');
    };
    await expect(b.engine.stop()).resolves.toBeUndefined();
  });
});

test('an identity change stops the engine and reports the reconnect state', async () => {
  await withTwoSyncDevices(
    async ({ a, b }) => {
      await a.commitProvider('work', { kind: 'api', apiKey: 'shared' }, true);
      await a.engine.reconcile(a.signal);
      b.failNext('read', 'before', 'identity-changed');
      const changed = b.waitForStatus('identity-changed');
      b.engine.start();
      await changed;
      // The backend already dropped the session, so nothing may be scheduled against it again.
      expect(b.disposeCount()).toBe(1);
      const applied = b.remoteApplyCalls().length;
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(b.remoteApplyCalls().length).toBe(applied);
      await b.engine.stop();
      expect(b.disposeCount()).toBe(1);
    },
    { watch: false },
  );
});

test('failed watch initialization disposes the session and repeated stop is safe', async () => {
  await withTwoSyncDevices(async ({ b }) => {
    const watch = b.session.watch!;
    b.session.watch = (onHint) => {
      watch(onHint);
      throw new Error('watch initialization failed');
    };
    expect(() => b.engine.start()).toThrow('watch initialization failed');
    await b.engine.stop();
    await b.engine.stop();
    expect(b.activeWatchCount()).toBe(0);
    expect(b.disposeCount()).toBe(1);
  });
});

test('a recreated engine recovers persisted local work without duplicating the session', async () => {
  await withTwoSyncDevices(async ({ b }) => {
    await b.preparePendingProvider('work', { kind: 'api', apiKey: 'restart' });
    expect(b.connectionCount()).toBe(2);
    await b.restartEngine();
    expect(b.connectionCount()).toBe(3);
    expect(b.disposeCount()).toBe(1);
    await b.engine.reconcile(b.signal);
    expect(b.repo.pendingCommits(b.binding.id)).toEqual([]);
    expect(b.repo.outbox(b.binding.id)).toEqual([]);
    expect((await createSyncObjectStore(b.session).readHead('provider-work', b.signal))?.head.state).toBe('active');
  });
});

test('backoff remains bounded', () => {
  let delay = 5;
  for (let index = 0; index < 20; index++) delay = nextBackoffMs(delay, 5);
  expect(delay).toBeLessThanOrEqual(MAX_BACKOFF_MS);
  expect(delay).toBeGreaterThanOrEqual(5);
});
