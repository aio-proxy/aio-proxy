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
