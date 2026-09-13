import { expect, test } from 'bun:test';

import { deleteEntity, restoreEntity } from '../cleanup';
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

// A refused body never became local state. Storing it as `desired` anyway hands the activation
// check its own rejected body as the record of what this device accepted, so the second poll
// approves what the first held back — and a `{{env.NAME}}` secret goes to the new destination.
test('a refused body does not become the approval source for the next poll', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: '{{env.TOKEN}}' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);
    const approved = b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-work')?.desired;
    expect(approved?.value).toMatchObject({ apiKey: '{{env.TOKEN}}' });

    b.setPendingActivation('secret-conflict');
    await a.commitProvider('work', { kind: 'api', apiKey: '{{env.TOKEN}}', baseUrl: 'https://attacker.test' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);

    const refused = b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-work');
    expect(refused?.pendingReason).toBe('secret-conflict');
    expect(refused?.desired).toEqual(approved!);
  });
});

// Importing a shared account during the activation await writes the row's ownership. The write-back
// below it carries the snapshot taken before the await, and erasing the ownership is unrecoverable:
// the account exists from then on, so the import never runs again.
test('ownership written while a remote application is in flight survives the write-back', async () => {
  const ownership = {
    mode: 'shared' as const,
    epoch: 0,
    generation: 2,
    localRevision: 4,
    pluginVersion: '1.0.0',
    formatVersion: 1,
  };
  await withTwoSyncDevices(async ({ a, b }) => {
    b.setPendingActivation('oauth-unverified');
    await a.commitProvider('work', { kind: 'api', apiKey: 'k' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);
    b.setPendingActivation(undefined);

    const gate = b.pauseRemoteApplication();
    const reconcile = b.engine.reconcile(b.signal);
    await gate.entered;
    const row = b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-work');
    b.repo.putEntity(b.binding.id, { ...row!, pendingReason: null, oauth: ownership });
    gate.release();
    await reconcile;

    expect(b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-work')?.oauth).toEqual(
      ownership,
    );
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

test('a duplicate resolved during the pass leaves the surviving object synchronized', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    const store = createSyncObjectStore(a.session);
    for (const suffix of ['a', 'b']) {
      await publishEntity(
        store,
        {
          operationId: `conflict-${suffix}-op`,
          objectId: `provider-conflict-${suffix}`,
          epoch: 0,
          kind: 'put',
          body: { kind: 'provider', logicalKey: 'conflict', value: { kind: 'api', key: suffix }, dependencies: [] },
          commitId: `fixture-${suffix}`,
        },
        a.signal,
      );
    }

    // The other device deletes one of the duplicates after discovery recorded both heads. Trusting
    // that snapshot would quarantine the survivor, and no later pass restores inclusion.
    const read = b.session.read.bind(b.session);
    let resolved = false;
    b.session.read = async (key, signal) => {
      const value = await read(key, signal);
      if (!resolved && key === entityKey('provider-conflict-b')) {
        resolved = true;
        await deleteEntity(store, 'provider-conflict-b', 0, a.signal);
      }
      return value;
    };

    await b.engine.reconcile(b.signal);

    expect(b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-conflict-a')).toMatchObject({
      mode: 'included',
      pendingReason: null,
    });
    expect(b.remoteApplyCalls()).toContainEqual(
      expect.objectContaining({ objectId: 'provider-conflict-a', body: { kind: 'api', key: 'a' } }),
    );
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

// Joining an existing local body can publish without changing the config file, so a pass that
// snapshotted the row as excluded must not write that stale decision back over the new baseline.
test('a join landing during reconciliation is not overwritten by the snapshot mode', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    await b.commitProvider('work', { kind: 'api', apiKey: 'local' }, false);
    await a.commitProvider('work', { kind: 'api', apiKey: 'shared' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);
    expect(b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-work')?.mode).toBe('excluded');

    const discovery = b.gateNext('read');
    const pending = b.engine.reconcile(b.signal);
    await discovery.entered;
    const main = b.gateNext('read');
    discovery.release();
    await main.entered;
    const row = b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-work');
    b.repo.putEntity(b.binding.id, { ...row!, mode: 'included', baseline: 'joined' });
    main.release();
    await pending;

    expect(b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-work')).toMatchObject({
      mode: 'included',
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

// A stale operation that can only throw is never acknowledged, so it would wedge the outbox and
// block every later pass — the drain has to recognize that the restore replaced what it was editing.
test('a queued operation superseded by a remote restore is dropped instead of wedging the outbox', async () => {
  await withTwoSyncDevices(async ({ a }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: 'first' }, true);
    await a.engine.reconcile(a.signal);
    const store = createSyncObjectStore(a.session);
    const body: EntityBody = {
      kind: 'provider',
      logicalKey: 'work',
      value: { kind: 'api', apiKey: 'restored' },
      dependencies: [],
    };
    await deleteEntity(store, 'provider-work', 0, a.signal);
    await restoreEntity(store, 'provider-work', body, 'remote-restore', a.signal);
    expect((await store.readHead('provider-work', a.signal))?.head.epoch).toBe(1);

    a.queueDelete('provider-work', 0);
    await a.commitProvider('work', { kind: 'api', apiKey: 'stale' }, true);
    await a.engine.reconcile(a.signal);

    expect(a.repo.outbox(a.binding.id)).toEqual([]);
    const head = await store.readHead('provider-work', a.signal);
    expect(head?.head).toMatchObject({ epoch: 1, state: 'active' });
  });
});

// Deleting and re-adding a provider while the backend is unreachable queues both operations at the
// same epoch. Publishing the delete leaves a tombstone that defeats the put, and the next remote
// reconciliation then removes the provider the user just re-added.
test('a queued delete superseded by a later put keeps the re-added object published', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: 'first' }, true);
    await a.engine.reconcile(a.signal);

    a.queueDelete('provider-work', 0);
    await a.commitProvider('work', { kind: 'api', apiKey: 'again' }, true);
    await a.engine.reconcile(a.signal);

    expect(a.repo.outbox(a.binding.id)).toEqual([]);
    const head = await createSyncObjectStore(a.session).readHead('provider-work', a.signal);
    expect(head?.head).toMatchObject({ epoch: 0, state: 'active' });
    await b.engine.reconcile(b.signal);
    expect(b.remoteApplyCalls()).toContainEqual(
      expect.objectContaining({ objectId: 'provider-work', body: { kind: 'api', apiKey: 'again' } }),
    );
    expect(b.remoteApplyCalls().some((call) => call.objectId === 'provider-work' && call.body === null)).toBe(false);
  });
});

test('overrides pinned while a remote application is in flight survive the write-back', async () => {
  const overrides = [{ path: ['apiKey'], value: 'device-local' }];
  await withTwoSyncDevices(async ({ a, b }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: 'first' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);

    await a.commitProvider('work', { kind: 'api', apiKey: 'second' }, true);
    await a.engine.reconcile(a.signal);

    // The pass snapshots the rows before it awaits the network, so an override Apply landing during
    // that await is invisible to it. Replaying the snapshot would unpin the path and let this very
    // update overwrite the value the user asked to keep device-local.
    const gate = b.pauseRemoteApplication();
    const reconcile = b.engine.reconcile(b.signal);
    await gate.entered;
    const row = b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-work');
    b.repo.putEntity(b.binding.id, { ...row!, overrides });
    gate.release();
    await reconcile;

    expect(b.repo.entities(b.binding.id).find((entity) => entity.objectId === 'provider-work')?.overrides).toEqual(
      overrides,
    );
  });
});

test('leaving the synchronized range drops the writes queued while the backend was offline', async () => {
  await withTwoSyncDevices(async ({ a, b }) => {
    await a.commitProvider('work', { kind: 'api', apiKey: 'k' }, true);
    await a.commitProvider('spare', { kind: 'api', apiKey: 's' }, true);
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);

    // Queued while the backend was unreachable: an edit to one Provider and the removal of another.
    await a.commitProvider('work', { kind: 'api', apiKey: 'device-local' }, true);
    await a.removeProvider('spare');
    const queued = a.repo.outbox(a.binding.id);
    expect(queued.some((operation) => operation.kind === 'put' && operation.objectId === 'provider-work')).toBe(true);
    expect(queued.some((operation) => operation.kind === 'delete' && operation.objectId === 'provider-spare')).toBe(
      true,
    );

    // `sync leave` on both: the edit must stay off the backend and the cloud copy must survive.
    for (const objectId of ['provider-work', 'provider-spare']) {
      const row = a.repo.entities(a.binding.id).find((entity) => entity.objectId === objectId);
      a.repo.putEntity(a.binding.id, { ...row!, mode: 'excluded' });
    }
    await a.engine.reconcile(a.signal);
    await b.engine.reconcile(b.signal);

    expect(a.repo.outbox(a.binding.id)).toEqual([]);
    const published = b.remoteApplyCalls().filter((call) => call.objectId === 'provider-work');
    expect(published.map((call) => call.body)).toEqual([{ kind: 'api', apiKey: 'k' }]);
    expect(b.remoteApplyCalls().filter((call) => call.objectId === 'provider-spare' && call.body === null)).toEqual([]);
  });
});

test('an outbox entry over the backend value limit yields to every later object', async () => {
  await withTwoSyncDevices(
    async ({ a, b }) => {
      await a.commitProvider('huge', { kind: 'api', apiKey: 'x'.repeat(2048) }, true);
      await a.commitProvider('small', { kind: 'api', apiKey: 'k' }, true);
      // The oversized entry is queued first and can never publish, but it must not hold the queue:
      // the later Provider reaches the backend and remote reconciliation still runs.
      await a.engine.reconcile(a.signal);
      await b.engine.reconcile(b.signal);
      expect(b.repo.entities(b.binding.id).map((entity) => entity.logicalKey)).toEqual(['small']);
      expect(a.repo.outbox(a.binding.id).map((operation) => operation.objectId)).toEqual(['provider-huge']);

      // Shrinking the configuration mints a newer operation, which supersedes the oversized one.
      await a.commitProvider('huge', { kind: 'api', apiKey: 'fits' }, true);
      await a.engine.reconcile(a.signal);
      await b.engine.reconcile(b.signal);
      expect(a.repo.outbox(a.binding.id)).toEqual([]);
      expect(
        b.repo
          .entities(b.binding.id)
          .map((entity) => entity.logicalKey)
          .sort(),
      ).toEqual(['huge', 'small']);
    },
    { maxValueBytes: 1024 },
  );
});
