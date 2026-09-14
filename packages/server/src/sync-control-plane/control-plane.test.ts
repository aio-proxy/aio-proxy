import { expect, test } from 'bun:test';

import { createSyncControlPlane } from './control-plane';

const BINDING = {
  id: 'binding-1',
  plugin: 'p',
  capability: 'c',
  identityId: 'i',
  spaceId: 's',
  deviceId: 'd',
  sessionGeneration: 1,
  options: {},
};

const CLOUD_ROW = {
  objectId: 'cloud-object',
  logicalKey: 'shared',
  kind: 'provider' as const,
  version: 'v1',
  revision: 'op-1',
  body: { kind: 'provider' as const, logicalKey: 'shared', value: { region: 'eu' }, dependencies: [] },
};

const REGISTRY = () =>
  ({
    resolveSync: () => ({ options: { schema: { safeParse: (value: unknown) => ({ success: true, data: value }) } } }),
    resolveOAuth: () => undefined,
  }) as never;

const CONNECT = { kind: 'connect', plugin: '@example/sync', capability: 'memory', options: {} } as const;

const LOCAL_ROW = {
  objectId: 'local-object',
  logicalKey: 'work',
  kind: 'provider' as const,
  mode: 'included' as const,
  epoch: 0,
  desired: { kind: 'provider' as const, logicalKey: 'work', value: { region: 'us' }, dependencies: [] },
  baseline: null,
  overrides: [],
  pendingReason: null,
};

const OVERRIDES = { kind: 'overrides', objectId: 'local-object', paths: [['region']] } as const;

test('an override preview loads the authored source so a local-only object has a body to pin', async () => {
  const excluded = (objectId: string, kind: 'provider' | 'plugin-business', logicalKey: string) => ({
    objectId,
    logicalKey,
    kind,
    mode: 'excluded' as const,
    epoch: 0,
    desired: null,
    baseline: null,
    overrides: [],
    pendingReason: null,
  });
  const control = createSyncControlPlane({
    repo: { readBinding: () => BINDING, entities: () => [], outbox: () => [], pendingCommits: () => [] } as never,
    binding: () => BINDING as never,
    localEntities: () => [
      excluded('local-fresh', 'provider', 'fresh'),
      excluded('local-plugin', 'plugin-business', '@example/business'),
    ],
    remoteEntities: async () => [],
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({ remote: [], commit: async () => {}, activate: () => {}, dispose: async () => {} }),
    committedSource: async () => ({
      raw: {
        plugins: [['@example/business', { endpoint: 'https://plugin.example.test' }]],
        providers: { fresh: { kind: 'ai-sdk', packageName: '@example/business', options: { region: 'eu' } } },
      },
      accounts: new Map(),
      pluginSecrets: new Map(),
      pluginVersions: new Map([['@example/business', '1.2.3']]),
    }),
  } as never);

  const preview = await control.preview({ kind: 'overrides', objectId: 'local-fresh', paths: [['options', 'region']] });

  // A local-only object has no published body, so without the authored source the row is null and
  // applying the override persists `undefined` for the very path it was meant to keep.
  expect(preview.rows[0]).toMatchObject({ objectId: 'local-fresh', local: { options: { region: 'eu' } } });
});

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
    connect: async () => ({ remote: [], commit: async () => {}, activate: () => {}, dispose: async () => {} }),
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

test('disconnect refuses to retire a binding that still owns a shared credential', async () => {
  const binding = { id: 'binding-1' };
  let cleared = 0;
  let closed = 0;
  const shared = {
    objectId: 'account-1',
    oauth: { mode: 'shared', epoch: 0, generation: 1, localRevision: 1, pluginVersion: '1.0.0', formatVersion: 1 },
  };
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => binding,
      entities: () => [shared],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      clearBinding: () => {
        cleared += 1;
      },
    } as never,
    binding: () => binding as never,
    localEntities: () => [],
    remoteEntities: async () => [],
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({ remote: [], commit: async () => {}, activate: () => {}, dispose: async () => {} }),
    lifecycle: {
      activate: () => {},
      reconcile: async () => {},
      close: async () => {
        closed += 1;
      },
    },
  });

  // Ownership names an account object in this backend's space, so a retired binding can never
  // detach it — and dropping the record would let the plain local port rotate a refresh token the
  // other devices still hold. Nothing is torn down before the user detaches.
  await expect(control.disconnect()).rejects.toMatchObject({ code: 'detach-required' });
  expect(closed).toBe(0);
  expect(cleared).toBe(0);
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
    connect: async () => ({ remote: [], commit: async () => {}, activate: () => {}, dispose: async () => {} }),
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

// The engine reports an unreachable backend and an entry it cannot publish through its status
// callback and resolves anyway, so overwriting that verdict with `idle` and a fresh timestamp tells
// the API and the Dashboard that a synchronization which never happened succeeded.
test('retry keeps the engine verdict when reconcile resolves without synchronizing', async () => {
  let handle: ((status: string) => void) | undefined;
  let reported: string | undefined = 'offline';
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => BINDING,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
    } as never,
    binding: () => BINDING as never,
    localEntities: () => [],
    remoteEntities: async () => [],
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({ remote: [], commit: async () => {}, activate: () => {}, dispose: async () => {} }),
    now: () => 1_000,
    onEngineStatus: (next) => {
      handle = next;
    },
    lifecycle: {
      activate: () => {},
      reconcile: async () => {
        if (reported !== undefined) handle!(reported);
      },
      close: async () => {},
    },
  } as never);

  expect(await control.retry()).toMatchObject({ state: 'offline', lastSuccessAt: null });
  reported = 'quota';
  expect(await control.retry()).toMatchObject({ state: 'quota', lastSuccessAt: null });

  // A pass that reports nothing still resolves as a success: the guard must not swallow that.
  reported = undefined;
  expect(await control.retry()).toMatchObject({ state: 'idle', lastSuccessAt: 1_000 });
});

test('a connect apply is refused when the configuration moved after the preview was reviewed', async () => {
  let commitId = 'commit-1';
  let committed = 0;
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => BINDING,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      putEntity: () => {},
      latestConfirmedCommit: () => ({ commitId }),
    } as never,
    binding: () => BINDING as never,
    localEntities: () => [],
    remoteEntities: async () => [CLOUD_ROW],
    registry: REGISTRY,
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote: [CLOUD_ROW],
      refresh: async () => [CLOUD_ROW],
      commit: async () => void (committed += 1),
      activate: () => {},
      dispose: async () => {},
    }),
  });

  const preview = await control.preview(CONNECT);
  // A configuration commit lands while the dialog sits open. The reviewed rows were projected from
  // local state as well as cloud state, and the per-row commit guard is deliberately disabled for a
  // connect, so re-reading only the cloud half would publish the superseded body or overwrite the
  // intervening edit with a cloud value — and the binding swap is irreversible.
  commitId = 'commit-2';

  await expect(
    control.apply({ previewId: preview.previewId, decisions: [{ objectId: 'cloud-object', choice: 'cloud' }] }),
  ).rejects.toMatchObject({ code: 'preview-stale' });
  expect(committed).toBe(0);
});

test('a first connect apply is refused when the configuration moved after the preview was reviewed', async () => {
  let region = 'us';
  let committed = 0;
  const control = createSyncControlPlane({
    // A first connect has no binding, so the binding and commit halves of the fence are empty for
    // both the preview and the Apply: the authored file is the only local state to fence against.
    repo: { readBinding: () => null, entities: () => [], outbox: () => [], pendingCommits: () => [] } as never,
    binding: () => null,
    localEntities: () => [],
    remoteEntities: async () => [CLOUD_ROW],
    registry: REGISTRY,
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote: [CLOUD_ROW],
      refresh: async () => [CLOUD_ROW],
      commit: async () => void (committed += 1),
      activate: () => {},
      dispose: async () => {},
    }),
    committedSource: async () => ({
      raw: { providers: { shared: { kind: 'api', protocol: 'openai-response', baseUrl: `https://${region}.test` } } },
      accounts: new Map(),
      pluginSecrets: new Map(),
      pluginVersions: new Map(),
    }),
  } as never);

  const preview = await control.preview(CONNECT);
  // The user edits the Provider the review offered a choice for while the dialog sits open. Importing
  // the cloud body would silently overwrite that edit, and publishing the reviewed local body would
  // record the superseded configuration as synchronized.
  region = 'eu';

  await expect(
    control.apply({ previewId: preview.previewId, decisions: [{ objectId: 'cloud-object', choice: 'cloud' }] }),
  ).rejects.toMatchObject({ code: 'preview-stale' });
  expect(committed).toBe(0);
});

test('a connect preview that finished opening after shutdown releases its backend session', async () => {
  let disposed = 0;
  let finishConnecting: (() => void) | undefined;
  const control = createSyncControlPlane({
    repo: { readBinding: () => null, entities: () => [], outbox: () => [], pendingCommits: () => [] } as never,
    binding: () => null,
    localEntities: () => [],
    remoteEntities: async () => [],
    registry: REGISTRY,
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => {
      await new Promise<void>((resolve) => {
        finishConnecting = resolve;
      });
      return {
        remote: [],
        refresh: async () => [],
        commit: async () => {},
        activate: () => {},
        dispose: async () => void (disposed += 1),
      };
    },
  });

  const pending = control.preview(CONNECT);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Teardown sees neither an executing Apply nor a retained preview: the session it has to release
  // does not exist yet. Retaining it afterwards would hold the backend — a native helper, for
  // CloudKit — open until the preview TTL, with nothing left running to expire it.
  await control.dispose();
  finishConnecting!();

  await expect(pending).rejects.toMatchObject({ code: 'backend-unavailable' });
  expect(disposed).toBe(1);
});

// The connect-only options the two fence tests below share: no binding, one cloud row, and a
// `committedSource` the test moves between reads.
const firstConnectOptions = (committedSource: () => Promise<unknown>, committed: () => void) =>
  ({
    repo: { readBinding: () => null, entities: () => [], outbox: () => [], pendingCommits: () => [] } as never,
    binding: () => null,
    localEntities: () => [],
    remoteEntities: async () => [CLOUD_ROW],
    registry: REGISTRY,
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote: [CLOUD_ROW],
      refresh: async () => [CLOUD_ROW],
      commit: async () => void committed(),
      activate: () => {},
      dispose: async () => {},
    }),
    committedSource,
  }) as never;

test('a first connect fences the exact configuration its rows were projected from', async () => {
  let reads = 0;
  let committed = 0;
  // The edit lands after the read the rows were projected from but before the fence is built. Sampling
  // the source twice would fence the newer digest, and the Apply — which reads live — would match it
  // and publish rows describing the configuration the user has already replaced.
  const control = createSyncControlPlane(
    firstConnectOptions(
      async () => {
        reads += 1;
        return {
          raw: { providers: { shared: { kind: 'api', baseUrl: `https://${reads === 1 ? 'us' : 'eu'}.test` } } },
          accounts: new Map(),
          pluginSecrets: new Map(),
          pluginVersions: new Map(),
        };
      },
      () => void (committed += 1),
    ),
  );

  const preview = await control.preview(CONNECT);

  await expect(
    control.apply({ previewId: preview.previewId, decisions: [{ objectId: 'cloud-object', choice: 'cloud' }] }),
  ).rejects.toMatchObject({ code: 'preview-stale' });
  expect(committed).toBe(0);
});

test('a first connect apply is refused when only a plugin secret moved after the review', async () => {
  let token = 'secret-1';
  let committed = 0;
  // Updating plugin options rewrites the repository-backed secret and leaves the configuration file
  // byte-identical, and the reviewed `plugin-business` body carries that secret. Before a binding
  // exists the mutation enqueues nothing either, so an Apply that accepted the stale preview would
  // publish the old secret with no later publication to correct it.
  const control = createSyncControlPlane(
    firstConnectOptions(
      async () => ({
        raw: { plugins: [['@example/business', {}]], providers: { shared: { kind: 'api' } } },
        accounts: new Map(),
        pluginSecrets: new Map([['@example/business', { token }]]),
        pluginVersions: new Map([['@example/business', '1.2.3']]),
      }),
      () => void (committed += 1),
    ),
  );

  const preview = await control.preview(CONNECT);
  token = 'secret-2';

  await expect(
    control.apply({ previewId: preview.previewId, decisions: [{ objectId: 'cloud-object', choice: 'cloud' }] }),
  ).rejects.toMatchObject({ code: 'preview-stale' });
  expect(committed).toBe(0);
});

test('an unfinished connect apply is remembered across a restart by the binding row', async () => {
  // How a crash between the binding swap and the reviewed decisions leaves the database: the row
  // is written pending by the connect that created it and only a completed Apply clears it.
  const binding = { ...BINDING, connectPending: true };
  const cleared: [string, boolean][] = [];
  let activated = 0;
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => binding,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      putEntity: () => {},
      setConnectPending: (id: string, pending: boolean) => void cleared.push([id, pending]),
    } as never,
    binding: () => binding as never,
    localEntities: () => [],
    remoteEntities: async () => [CLOUD_ROW],
    registry: REGISTRY,
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote: [CLOUD_ROW],
      refresh: async () => [CLOUD_ROW],
      commit: async () => {},
      activate: () => {},
      dispose: async () => {},
    }),
    lifecycle: {
      activate: () => void (activated += 1),
      reconcile: async () => {},
      close: async () => {},
    },
  });

  // The in-memory guard died with the process, so a restarted service would otherwise report a
  // working backend and let retry() start the engine, importing the very revision the user chose to
  // overwrite. Only a fresh connect preview re-reviews those rows.
  expect(control.status().state).toBe('preview-required');
  await expect(control.retry()).rejects.toMatchObject({ code: 'preview-stale' });
  expect(activated).toBe(0);

  const preview = await control.preview(CONNECT);
  await control.apply({ previewId: preview.previewId, decisions: [{ objectId: 'cloud-object', choice: 'cloud' }] });

  // Completing the review is the one thing that clears the flag, or every later restart re-enters
  // `preview-required` on a backend that is in fact fully applied.
  expect(cleared).toEqual([['binding-1', false]]);
  expect(control.status().state).toBe('idle');
});

// Applying a connect swaps the binding before the reviewed decisions land, and the new binding gets
// its own freshly seeded rows. The row half of the fence is checked against a capture taken before
// that swap; re-reading it afterwards compares the old binding's review against the new binding's
// rows, so every connect Apply would be stale against its own preview.
test('a connect apply survives the binding swap reseeding the local rows', async () => {
  let binding: Record<string, unknown> = { ...BINDING };
  let rows = [LOCAL_ROW];
  let imported = 0;
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => binding,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      putEntity: () => {},
      setConnectPending: () => {},
    } as never,
    binding: () => binding as never,
    localEntities: () => rows,
    remoteEntities: async () => [CLOUD_ROW],
    registry: REGISTRY,
    applyLocal: async () => void (imported += 1),
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote: [CLOUD_ROW],
      refresh: async () => [CLOUD_ROW],
      commit: async () => {
        binding = { ...BINDING, id: 'binding-2', sessionGeneration: 2 };
        rows = [{ ...LOCAL_ROW, objectId: 'seeded-object', mode: 'excluded' as const }];
      },
      activate: () => {},
      dispose: async () => {},
    }),
    lifecycle: { activate: () => {}, reconcile: async () => {}, close: async () => {} },
  });

  const preview = await control.preview(CONNECT);
  await control.apply({ previewId: preview.previewId, decisions: [{ objectId: 'cloud-object', choice: 'cloud' }] });

  expect(imported).toBe(1);
  expect(control.status().state).toBe('idle');
});

// The binding is already swapped when the reviewed import fails, so every row sits on a baseline the
// candidate backend has moved past. Reviewing or applying anything else against them would report
// success and hand the state back to `idle` while the engine stays held, and a preview captured
// before the failed connect describes rows that now belong to another binding entirely.
test('a failed connect apply refuses every other preview until a fresh connect review', async () => {
  let binding: Record<string, unknown> = { ...BINDING };
  let importFails = true;
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => binding,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      putEntity: () => {},
      setConnectPending: () => {},
    } as never,
    binding: () => binding as never,
    localEntities: () => [LOCAL_ROW],
    remoteEntities: async () => [CLOUD_ROW],
    registry: REGISTRY,
    applyLocal: async () => {
      if (importFails) throw new Error('import failed');
    },
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote: [CLOUD_ROW],
      refresh: async () => [CLOUD_ROW],
      commit: async () => void (binding = { ...BINDING, id: 'binding-2', sessionGeneration: 2 }),
      activate: () => {},
      dispose: async () => {},
    }),
    lifecycle: { activate: () => {}, reconcile: async () => {}, close: async () => {} },
  });

  const stale = await control.preview(OVERRIDES);
  const connect = await control.preview(CONNECT);
  await expect(
    control.apply({ previewId: connect.previewId, decisions: [{ objectId: 'cloud-object', choice: 'cloud' }] }),
  ).rejects.toThrow('import failed');

  await expect(
    control.apply({ previewId: stale.previewId, decisions: [{ objectId: 'local-object', choice: 'local' }] }),
  ).rejects.toMatchObject({ code: 'preview-stale' });
  await expect(control.preview(OVERRIDES)).rejects.toMatchObject({
    code: 'preview-stale',
  });

  // Only a completed connect review clears it, and then the ordinary previews work again.
  importFails = false;
  const retry = await control.preview(CONNECT);
  await control.apply({ previewId: retry.previewId, decisions: [{ objectId: 'cloud-object', choice: 'cloud' }] });
  expect((await control.preview(OVERRIDES)).previewId).toBeString();
});

test('a second connect apply cannot swap the binding while the first is still publishing', async () => {
  // Applying takes the preview out of the store, so `disposePending()` no longer sees the Apply in
  // flight and a second connect preview can be reviewed and applied over it.
  let binding: Record<string, unknown> = { ...BINDING };
  const committed: string[] = [];
  const cleared: [string, boolean][] = [];
  const publishedAgainst: string[] = [];
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const candidate = (id: string) => ({
    remote: [CLOUD_ROW],
    // Suspends each Apply before its fence check, so the second preview is reviewed and applied
    // while the first is still in flight and both read the original binding into their fences.
    refresh: async () => {
      await tick();
      return [CLOUD_ROW];
    },
    commit: async () => {
      committed.push(id);
      binding = { ...BINDING, id, sessionGeneration: committed.length + 1 };
    },
    activate: () => {},
    dispose: async () => {},
  });
  let next = 0;
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => binding,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      putEntity: () => {},
      setConnectPending: (id: string, pending: boolean) => void cleared.push([id, pending]),
    } as never,
    binding: () => binding as never,
    localEntities: () => [],
    remoteEntities: async () => [CLOUD_ROW],
    registry: REGISTRY,
    applyLocal: async () => {
      // Where the reviewed decisions land: the binding in force here must be the one they were
      // reviewed against, not one a competing Apply swapped in underneath.
      publishedAgainst.push(binding['id'] as string);
      await tick();
    },
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => candidate(`swapped-${(next += 1)}`),
  });

  const first = await control.preview(CONNECT);
  const firstApply = control.apply({
    previewId: first.previewId,
    decisions: [{ objectId: 'cloud-object', choice: 'cloud' }],
  });
  // The first Apply is parked in refresh(), before its fence check and its swap.
  await Promise.resolve();

  const second = await control.preview(CONNECT);
  const secondApply = control.apply({
    previewId: second.previewId,
    decisions: [{ objectId: 'cloud-object', choice: 'cloud' }],
  });

  await firstApply;
  // The second swap would otherwise replace and close the first lifecycle mid-publication, leaving
  // the first Apply writing its reviewed choices to a backend the user never reviewed them against.
  await expect(secondApply).rejects.toMatchObject({ code: 'preview-stale' });
  expect(committed).toEqual(['swapped-1']);
  expect(publishedAgainst).toEqual(['swapped-1']);
  // Clearing `connectPending` is what tells a restarted service the review finished, so the second
  // Apply must not clear it for a binding whose own Apply never ran.
  expect(cleared).toEqual([['swapped-1', false]]);
});

test('retry cannot activate the engine a connect apply is still swapping in', async () => {
  // Retry refuses to reconnect over an unfinished connect review by reading `connectApplyIncomplete`,
  // but an Apply still short of its swap has not set that flag yet. Unserialized, Retry passes the
  // check, parks in `start()`, and resumes on whatever engine the swap installed — reconciling the
  // cloud backend before the reviewed decisions land.
  let binding: Record<string, unknown> = { ...BINDING };
  const events: string[] = [];
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  let swapped = () => {};
  const afterSwap = new Promise<void>((resolve) => {
    swapped = resolve;
  });
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => binding,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      putEntity: () => {},
      setConnectPending: () => {},
    } as never,
    binding: () => binding as never,
    localEntities: () => [],
    remoteEntities: async () => [CLOUD_ROW],
    registry: REGISTRY,
    applyLocal: async () => {
      // The swap is done: release the Retry waiting in `start()` and keep publishing, so an
      // unserialized Retry has every chance to overtake the reviewed import.
      swapped();
      await tick();
      await tick();
      events.push('import');
    },
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote: [CLOUD_ROW],
      // Parks the Apply before its fence check, so Retry starts while the binding is still the old one.
      refresh: async () => {
        await tick();
        return [CLOUD_ROW];
      },
      commit: async () => void (binding = { ...BINDING, id: 'binding-2', sessionGeneration: 2 }),
      activate: () => {},
      dispose: async () => {},
    }),
    lifecycle: {
      start: async () => {
        await afterSwap;
      },
      activate: () => void events.push('activate'),
      reconcile: async () => {},
      close: async () => {},
    },
  });

  const preview = await control.preview(CONNECT);
  const apply = control.apply({
    previewId: preview.previewId,
    decisions: [{ objectId: 'cloud-object', choice: 'cloud' }],
  });
  const retry = control.retry();

  await apply;
  await retry;
  expect(events).toEqual(['import', 'activate']);
});

test('a second non-connect apply cannot publish over the first reviewed decision', async () => {
  // Applying takes the preview out of the store, so two ordinary Applies can be in flight together.
  // Both then pass their fence and commit checks — those run inside applyPreview — before either
  // mutates anything, and the second would write its stale reviewed body over the first decision.
  let commitId = 'commit-1';
  const appliedAgainst: string[] = [];
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => BINDING,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      putEntity: () => {},
      latestConfirmedCommit: () => ({ commitId }),
    } as never,
    binding: () => BINDING as never,
    localEntities: () => [
      {
        objectId: 'cloud-object',
        logicalKey: 'shared',
        kind: 'provider' as const,
        mode: 'excluded' as const,
        epoch: 0,
        desired: null,
        baseline: null,
        overrides: [],
        pendingReason: null,
      },
    ],
    // Suspends each Apply before it reads its fence, so both are past `take()` and neither has
    // written anything yet.
    remoteEntities: async () => {
      await tick();
      return [CLOUD_ROW];
    },
    registry: REGISTRY,
    // A cloud choice writes the reviewed body into the configuration, which is the commit the other
    // Apply's fence is supposed to notice.
    applyLocal: async () => {
      // Suspending here too leaves the first Apply past its fence check and not yet committed, which
      // is the window the second Apply must not be allowed to read.
      await tick();
      appliedAgainst.push(commitId);
      commitId = `commit-${appliedAgainst.length + 1}`;
    },
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({ remote: [], commit: async () => {}, activate: () => {}, dispose: async () => {} }),
    committedSource: async () => ({
      raw: { providers: { shared: { kind: 'api', baseUrl: 'https://local.example.test' } } },
      accounts: new Map(),
      pluginSecrets: new Map(),
      pluginVersions: new Map(),
    }),
  } as never);

  // The store holds a preview per ID, so two dialogs can be reviewed and then both submitted.
  const first = await control.preview({ kind: 'join', providerId: 'shared' });
  const second = await control.preview({ kind: 'join', providerId: 'shared' });
  const firstApply = control.apply({
    previewId: first.previewId,
    decisions: [{ objectId: 'cloud-object', choice: 'cloud' }],
  });
  const secondApply = control.apply({
    previewId: second.previewId,
    decisions: [{ objectId: 'cloud-object', choice: 'cloud' }],
  });

  await firstApply;
  await expect(secondApply).rejects.toMatchObject({ code: 'preview-stale' });
  expect(appliedAgainst).toEqual(['commit-1']);
});

test('disconnect waits for a connect apply already past its fence check', async () => {
  let binding: Record<string, unknown> | null = { ...BINDING };
  const events: string[] = [];
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  let disconnect: Promise<unknown> | undefined;
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => binding,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      putEntity: () => {},
      setConnectPending: () => {},
      clearBinding: () => {
        events.push('cleared');
        binding = null;
      },
    } as never,
    binding: () => binding as never,
    localEntities: () => [],
    remoteEntities: async () => [CLOUD_ROW],
    registry: REGISTRY,
    applyLocal: async () => {
      events.push('applied');
      await tick();
    },
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({
      remote: [CLOUD_ROW],
      refresh: async () => [CLOUD_ROW],
      commit: async () => {
        // The fence check has passed, so the teardown can no longer stop this candidate from
        // installing its binding — `lifetime` is not the session it publishes through.
        disconnect ??= control.disconnect();
        await tick();
        events.push('committed');
        binding = { ...BINDING, id: 'swapped', sessionGeneration: 2 };
      },
      activate: () => {},
      dispose: async () => {},
    }),
    lifecycle: {
      activate: () => {},
      reconcile: async () => {},
      close: async () => void events.push('closed'),
    },
  });

  const preview = await control.preview(CONNECT);
  await control.apply({
    previewId: preview.previewId,
    decisions: [{ objectId: 'cloud-object', choice: 'cloud' }],
  });

  // Interleaved, the reviewed decisions land after the teardown reported success, leaving the new
  // binding in place and synchronization running against a backend the user just disconnected.
  expect(await disconnect).toMatchObject({ state: 'disconnected' });
  expect(events).toEqual(['committed', 'applied', 'closed', 'cleared']);
  expect(binding).toBeNull();
});

test('a preview against a bound backend that never connected fails instead of reading as empty', async () => {
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => BINDING,
      entities: () => [],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
    } as never,
    binding: () => BINDING as never,
    localEntities: () => [],
    // The persisted binding survived a restart the backend was offline for, so the lifecycle holds
    // no session yet.
    session: () => undefined,
    applyLocal: async () => {},
    persistOverrides: async () => {},
    connect: async () => ({ remote: [], commit: async () => {}, activate: () => {}, dispose: async () => {} }),
  } as never);

  // An empty cloud snapshot would leave the purge preview with no rows, and applying it erases
  // nothing while still reporting success.
  await expect(control.preview({ kind: 'purge', scope: 'provider', objectId: 'shared' })).rejects.toMatchObject({
    code: 'not-connected',
  });
  expect(control.status().state).toBe('offline');
  // Empty history on an unreachable backend reads as "the recovery revisions are gone".
  await expect(control.history('shared')).rejects.toMatchObject({ code: 'not-connected' });
});

test('a leave waits for an apply whose reviewed import is already in flight, and stales previews queued behind it', async () => {
  // The reviewed import bypasses the excluded-row guard by design — it writes into a row whose
  // inclusion is recorded right after it — so an exclusion landing while the Apply awaits its remote
  // write would still put the cloud body into the configuration after Leave reported success. The
  // reviewed fence is long past by then, and the range check only holds the row's mode back.
  const events: string[] = [];
  const body = (value: string) => ({
    kind: 'provider' as const,
    logicalKey: 'shared',
    value: { value },
    dependencies: [],
  });
  let row = {
    objectId: 'cloud-object',
    logicalKey: 'shared',
    kind: 'provider' as const,
    mode: 'included' as const,
    epoch: 1,
    desired: body('local'),
    baseline: null,
    overrides: [],
    pendingReason: null,
  };
  let leaving: Promise<unknown> = Promise.resolve();
  let queued: { previewId: string } | undefined;
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => BINDING,
      entities: () => [row],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      putEntity: (_bindingId: string, entity: typeof row) => {
        row = entity;
      },
      latestConfirmedCommit: () => ({ commitId: 'commit-1' }),
    } as never,
    binding: () => BINDING as never,
    localEntities: () => [row],
    remoteEntities: async () => [{ ...CLOUD_ROW, body: body('current'), revisions: { old: body('old') } }],
    registry: REGISTRY,
    restore: async () => {
      // The window the reviewed fence no longer covers: past every check, waiting on the backend.
      // Awaiting the Leave here would deadlock on the very queue under test, and a separate request
      // does not await it either.
      leaving = control.setRange('shared', false).then(() => events.push('leave'));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      // Taken while the row is still included and the Leave is only queued: its Apply must not be
      // able to put the cloud body back once the exclusion lands.
      queued = await control.preview({ kind: 'restore', objectId: 'cloud-object', operationId: 'old' });
    },
    applyLocal: async () => {
      events.push('import');
    },
    applyCloud: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({ remote: [], commit: async () => {}, activate: () => {}, dispose: async () => {} }),
  } as never);

  const preview = await control.preview({ kind: 'restore', objectId: 'cloud-object', operationId: 'old' });
  await control.apply({ previewId: preview.previewId, decisions: [{ objectId: 'cloud-object', choice: 'restore' }] });
  await leaving;

  expect(events).toEqual(['import', 'leave']);
  // The Leave still lands: serializing it only decides when.
  expect(row.mode).toBe('excluded');
  await expect(
    control.apply({ previewId: queued?.previewId ?? '', decisions: [{ objectId: 'cloud-object', choice: 'restore' }] }),
  ).rejects.toMatchObject({ code: 'preview-stale' });
});

// A preview reads its local rows first, then the committed source and the remote range over the
// network, and it does not hold the mutation queue. A Leave completing in that window used to pair
// the pre-Leave included row with the post-Leave range revision, so the reviewed join passed its
// fence and re-included the Provider Leave had already reported success for.
test('a leave completing while a join preview is being built makes the preview stale', async () => {
  let row = {
    objectId: 'local-object',
    logicalKey: 'shared',
    kind: 'provider' as const,
    mode: 'included' as const,
    epoch: 1,
    desired: { kind: 'provider' as const, logicalKey: 'shared', value: { region: 'eu' }, dependencies: [] },
    baseline: null,
    overrides: [],
    pendingReason: null,
  };
  let left = false;
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => BINDING,
      entities: () => [row],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      putEntity: (_bindingId: string, entity: typeof row) => {
        row = entity;
      },
      latestConfirmedCommit: () => ({ commitId: 'commit-1' }),
    } as never,
    binding: () => BINDING as never,
    localEntities: () => [row],
    remoteEntities: async () => [],
    registry: REGISTRY,
    applyLocal: async () => {},
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({ remote: [], commit: async () => {}, activate: () => {}, dispose: async () => {} }),
    committedSource: async () => {
      // Past the row snapshot and still awaiting the source: previewing takes no lock, so a Leave
      // request really does land here.
      if (!left) {
        left = true;
        await control.setRange('shared', false);
      }
      return {
        raw: { providers: { shared: { kind: 'api', baseUrl: 'https://shared.example.test' } } },
        accounts: new Map(),
        pluginSecrets: new Map(),
        pluginVersions: new Map(),
      };
    },
  } as never);

  const preview = await control.preview({ kind: 'join', providerId: 'shared' });

  expect(row.mode).toBe('excluded');
  await expect(
    control.apply({
      previewId: preview.previewId,
      decisions: preview.rows.map((previewRow) => ({ objectId: previewRow.objectId, choice: previewRow.choices[0]! })),
    }),
  ).rejects.toMatchObject({ code: 'preview-stale' });
  // Re-including it is the harm: the row must still be excluded once the stale apply is refused.
  expect(row.mode).toBe('excluded');
});

// An overrides Apply rewrites only the synchronization row: it moves neither `localCommitId` nor
// `rangeRevision`, so a join preview reviewed before it used to pass its fence and publish the body
// projected from the paths the user has since pinned.
test('an overrides apply landing after a join preview makes the preview stale', async () => {
  const row = {
    objectId: 'local-object',
    logicalKey: 'shared',
    kind: 'provider' as const,
    mode: 'included' as const,
    epoch: 1,
    desired: { kind: 'provider' as const, logicalKey: 'shared', value: { region: 'eu' }, dependencies: [] },
    baseline: null,
    overrides: [] as readonly (readonly string[])[],
    pendingReason: null,
  };
  const published: string[] = [];
  const control = createSyncControlPlane({
    repo: {
      readBinding: () => BINDING,
      entities: () => [row],
      outbox: () => [],
      pendingCommits: () => [],
      oauthJournals: () => [],
      putEntity: () => {},
      latestConfirmedCommit: () => ({ commitId: 'commit-1' }),
    } as never,
    binding: () => BINDING as never,
    localEntities: () => [row],
    remoteEntities: async () => [],
    registry: REGISTRY,
    applyLocal: async () => void published.push('local'),
    applyCloud: async () => {},
    restore: async () => {},
    persistOverrides: async () => {},
    purge: async () => {},
    connect: async () => ({ remote: [], commit: async () => {}, activate: () => {}, dispose: async () => {} }),
  } as never);

  const preview = await control.preview({ kind: 'join', providerId: 'shared' });
  // The overrides Apply the user ran in between, pinning `region` locally.
  row.overrides = [['region']];

  await expect(
    control.apply({
      previewId: preview.previewId,
      decisions: preview.rows.map((previewRow) => ({ objectId: previewRow.objectId, choice: previewRow.choices[0]! })),
    }),
  ).rejects.toMatchObject({ code: 'preview-stale' });
  // Publishing the pre-pin body is the harm: nothing may reach the backend.
  expect(published).toEqual([]);
});
