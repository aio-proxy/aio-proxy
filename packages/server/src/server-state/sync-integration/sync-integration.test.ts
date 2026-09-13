import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AtomicConfigExpectedDigestError,
  AtomicConfigFile,
  createPluginRepository,
  createSyncRepository,
  encode,
  encodeCandidate,
  entityKey,
  newHead,
  publish,
  reserve,
  revisionKey,
  type JsonValue,
  type LocalCommitPort,
  type PluginRegistrySnapshot,
} from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';

import type { ServerRuntime } from '../lifecycle';
import { createSyncControlPlaneIntegration } from './control-plane-integration';
import { createSyncIntegration, syncCommitOption } from './sync-integration';

test('remote apply rejects a stale digest without overwriting an external edit', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-integration-'));
  const configPath = join(home, 'config.jsonc');
  const initial = { providers: { local: { kind: 'api', baseUrl: 'https://local.example.test' } } };
  const external = { providers: { external: { kind: 'api', baseUrl: 'https://external.example.test' } } };
  const remote = { providers: { remote: { kind: 'api', baseUrl: 'https://remote.example.test' } } };
  writeFileSync(configPath, encodeCandidate(initial, configPath));
  const db = openDb({ home });
  const file = new AtomicConfigFile(configPath);
  const digest = createHash('sha256').update(encodeCandidate(initial, configPath)).digest('hex');
  const runtime = { options: { configPath }, remoteConfigFence: undefined } as unknown as ServerRuntime;
  const accounts = createPluginRepository(db.sqlite);

  try {
    await file.replace(() => external);
    const integration = createSyncIntegration(
      runtime,
      db,
      accounts,
      () => ({ plugins: new Map(), registry: {} }) as unknown as PluginRegistrySnapshot,
      file,
      { configPath } as never,
      async <T>(run: () => Promise<T>) => run(),
    );
    await expect(
      integration.syncApplyCandidate(remote, 'remote', 'remote-operation', undefined, digest),
    ).rejects.toBeInstanceOf(AtomicConfigExpectedDigestError);
    expect(await file.read()).toEqual(external);
    expect(runtime.remoteConfigFence).toBeUndefined();
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

function candidateFixture(
  home: string,
  list: (signal: AbortSignal) => Promise<{ keys: string[] }>,
  cloud: Record<string, JsonValue> = {},
  initial: JsonValue = { providers: {} },
) {
  const configPath = join(home, 'config.jsonc');
  writeFileSync(configPath, encodeCandidate(initial, configPath));
  const db = openDb({ home });
  const signals: AbortSignal[] = [];
  let disposed = 0;
  const session = {
    spaceId: 'default',
    identityId: 'identity',
    list: (_query: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return list(signal);
    },
    read: (key: string) =>
      Promise.resolve(
        Object.hasOwn(cloud, key)
          ? { kind: 'value' as const, value: encode(cloud[key]), version: 'v1', modifiedAt: 1 }
          : { kind: 'absent' as const },
      ),
    dispose: () => {
      disposed += 1;
      return Promise.resolve();
    },
  };
  const registry = {
    resolveSync: () => ({
      options: { schema: { safeParse: (value: unknown) => ({ success: true, data: value }) } },
      connect: () => Promise.resolve(session),
    }),
  };
  const runtime = { options: { configPath }, remoteConfigFence: undefined } as unknown as ServerRuntime;
  const integration = createSyncIntegration(
    runtime,
    db,
    createPluginRepository(db.sqlite),
    () => ({ plugins: new Map(), registry }) as unknown as PluginRegistrySnapshot,
    new AtomicConfigFile(configPath),
    { configPath } as never,
    async <T>(run: () => Promise<T>) => run(),
  );
  return { db, integration, runtime, signals, registry, disposed: () => disposed };
}

// The candidate holds `connectQueue` while it reads the cloud snapshot, so an un-owned signal would
// leave a stalled backend blocking every later connect, and its per-attempt directory behind.
test('a connect candidate aborts its backend reads and clears its data directory once it is done', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-candidate-'));
  const fixture = candidateFixture(home, () => Promise.resolve({ keys: [] }));
  try {
    const candidate = await fixture.integration.connectBackend({
      plugin: 'p',
      capability: 'c',
      options: {},
    });
    const [signal] = fixture.signals;
    expect(signal!.aborted).toBe(false);
    expect(readdirSync(join(home, '.sync'))).toHaveLength(1);
    await candidate.dispose();
    expect(signal!.aborted).toBe(true);
    expect(fixture.disposed()).toBe(1);
    expect(readdirSync(join(home, '.sync'))).toHaveLength(0);
  } finally {
    fixture.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a connect attempt that fails mid-snapshot leaves no data directory behind', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-candidate-fail-'));
  const fixture = candidateFixture(home, () => Promise.reject(new Error('network lost')));
  try {
    await expect(fixture.integration.connectBackend({ plugin: 'p', capability: 'c', options: {} })).rejects.toThrow();
    expect(fixture.signals[0]!.aborted).toBe(true);
    expect(readdirSync(join(home, '.sync'))).toHaveLength(0);
  } finally {
    fixture.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// The preview store holds the only reference to a reviewed candidate's backend session, so shutdown
// has to dispose it: otherwise a connect preview the user walked away from keeps its helper process
// alive until the preview TTL and delays the next service start.
test('disposing the control plane releases a connect candidate left pending', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-dispose-'));
  const fixture = candidateFixture(home, () => Promise.resolve({ keys: [] }));
  try {
    const plane = createSyncControlPlaneIntegration(
      {
        manager: { current: () => ({ plugins: { registry: fixture.registry } }) },
        repository: createPluginRepository(fixture.db.sqlite),
      } as unknown as ServerRuntime,
      fixture.integration,
      { get: () => undefined } as never,
    )!;

    await plane.preview({ kind: 'connect', plugin: 'p', capability: 'c', options: {} });
    expect(fixture.disposed()).toBe(0);
    await plane.dispose();
    expect(fixture.disposed()).toBe(1);
  } finally {
    fixture.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// Apply takes the candidate out of the preview store, so a shutdown while its pre-Apply re-read is
// stalled cannot reach the backend session through the store any more: it would return with the
// helper still running and the Apply still holding the serialized queue until its own bound expires.
test('disposing the control plane aborts an Apply stalled in its pre-Apply re-read', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-inflight-'));
  let reached!: () => void;
  const refreshing = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let calls = 0;
  const fixture = candidateFixture(home, (signal) => {
    calls += 1;
    if (calls === 1) return Promise.resolve({ keys: [] });
    reached();
    return new Promise<{ keys: string[] }>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('backend stalled')));
    });
  });
  try {
    const plane = createSyncControlPlaneIntegration(
      {
        manager: { current: () => ({ plugins: { registry: fixture.registry } }) },
        repository: createPluginRepository(fixture.db.sqlite),
      } as unknown as ServerRuntime,
      fixture.integration,
      { get: () => undefined } as never,
    )!;

    const preview = await plane.preview({ kind: 'connect', plugin: 'p', capability: 'c', options: {} });
    // An empty cloud makes every reviewed row optional, so no decision is owed.
    const apply = plane.apply({ previewId: preview.previewId, decisions: [] }).then(
      () => 'applied',
      () => 'failed',
    );
    await refreshing;
    await plane.dispose();
    expect(await apply).toBe('failed');
    expect(fixture.disposed()).toBe(1);
  } finally {
    fixture.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// A second Apply leaves the preview store the moment it is called and then waits its turn behind the
// first, so between those two points two candidates are unreachable through the store at once and
// shutdown has to release both — the queued one and the one actually refreshing.
test('disposing the control plane releases both the executing and the queued Apply candidate', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-queued-'));
  let reached!: () => void;
  const refreshing = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let calls = 0;
  const fixture = candidateFixture(home, (signal) => {
    calls += 1;
    // Only the first Apply's re-read stalls; the second preview still needs its own snapshot.
    if (calls !== 2) return Promise.resolve({ keys: [] });
    reached();
    return new Promise<{ keys: string[] }>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('backend stalled')));
    });
  });
  try {
    const plane = createSyncControlPlaneIntegration(
      {
        manager: { current: () => ({ plugins: { registry: fixture.registry } }) },
        repository: createPluginRepository(fixture.db.sqlite),
      } as unknown as ServerRuntime,
      fixture.integration,
      { get: () => undefined } as never,
    )!;

    const first = await plane.preview({ kind: 'connect', plugin: 'p', capability: 'c', options: {} });
    const stalled = plane.apply({ previewId: first.previewId, decisions: [] }).catch(() => {});
    await refreshing;
    const second = await plane.preview({ kind: 'connect', plugin: 'p', capability: 'c', options: {} });
    const queued = plane.apply({ previewId: second.previewId, decisions: [] }).catch(() => {});

    await plane.dispose();
    expect(fixture.disposed()).toBe(2);
    await Promise.all([stalled, queued]);
  } finally {
    fixture.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// Epoch and baseline name a head in the space being left. Carried into the new binding, the first
// publication submits an epoch the candidate backend never issued and Apply fails `epoch-mismatch`,
// while the carried baseline marks a remote revision applied that this binding has never seen.
test('a carried row is rebased onto the protocol state the candidate backend holds', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-carry-'));
  const fixture = candidateFixture(home, () => Promise.resolve({ keys: [] }));
  try {
    const repo = createSyncRepository(fixture.db.sqlite);
    repo.writeBinding({
      id: 'binding-old',
      plugin: 'p',
      capability: 'c',
      pluginVersion: '1.0.0',
      identityId: 'identity',
      spaceId: 'default',
      deviceId: 'device',
      sessionGeneration: 1,
      options: {},
    });
    repo.putEntity('binding-old', {
      objectId: 'object-1',
      logicalKey: 'work',
      kind: 'provider',
      mode: 'included',
      epoch: 7,
      desired: { kind: 'provider', logicalKey: 'work', value: {}, dependencies: [] },
      baseline: 'revision-9',
      overrides: [],
      pendingReason: null,
    });

    const candidate = await fixture.integration.connectBackend({ plugin: 'p', capability: 'c', options: {} });
    await candidate.commit();

    const bindingId = repo.readBinding()!.id;
    expect(bindingId).not.toBe('binding-old');
    expect(repo.entities(bindingId)).toMatchObject([{ objectId: 'object-1', epoch: 0, baseline: null }]);
  } finally {
    fixture.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// Shutdown closes whatever `runtime.sync` held when it read it, so a swap allowed to finish after
// that read would install a lifecycle — and for CloudKit a native helper — that nothing closes.
test('a backend swap that reaches the fence after teardown began installs nothing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-teardown-'));
  const fixture = candidateFixture(home, () => Promise.resolve({ keys: [] }));
  try {
    const previous = fixture.runtime.sync;
    const candidate = await fixture.integration.connectBackend({ plugin: 'p', capability: 'c', options: {} });
    fixture.runtime.closed = true;

    await expect(candidate.commit()).rejects.toThrow();

    expect(createSyncRepository(fixture.db.sqlite).readBinding()).toBeNull();
    expect(fixture.runtime.sync).toBe(previous);
    expect(readdirSync(join(home, '.sync'))).toHaveLength(0);
  } finally {
    fixture.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// A first connection has no binding rows, so the connect preview lists the cloud's `work` object
// alone and its reviewed decision imports that object's own row. Seeding a second row for the
// identically named authored Provider makes the first reconciliation quarantine both as a
// provider-id conflict, on a device that only ever authored one `work`.
test('a first connection seeds no duplicate for an identity the candidate already holds', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-seed-'));
  const body = { kind: 'provider' as const, logicalKey: 'work', value: { kind: 'api' }, dependencies: [] };
  const fixture = candidateFixture(
    home,
    () => Promise.resolve({ keys: [entityKey('object-cloud')] }),
    {
      [entityKey('object-cloud')]: publish(reserve(newHead('object-cloud', body), 'op-1', 0), 'op-1', 0) as never,
      [revisionKey('object-cloud', 'op-1')]: {
        protocol: 1,
        state: 'payload',
        objectId: 'object-cloud',
        epoch: 0,
        operationId: 'op-1',
        body,
        publishedSequence: 1,
        writtenAt: 1,
      } as never,
    },
    { providers: { work: { kind: 'api', baseUrl: 'https://work.example.test' } }, router: { models: { 'gpt-5': {} } } },
  );
  try {
    const candidate = await fixture.integration.connectBackend({ plugin: 'p', capability: 'c', options: {} });
    await candidate.commit();

    const repo = createSyncRepository(fixture.db.sqlite);
    // Everything else the configuration authors is still seeded; only `work` waits for its cloud row.
    expect(
      repo
        .entities(repo.readBinding()!.id)
        .map((entity) => `${entity.kind}/${entity.logicalKey}`)
        .sort(),
    ).toEqual(['model-rule/gpt-5', 'routing-defaults/routing-defaults']);
  } finally {
    fixture.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// A queued disconnect or backend replacement can land between a config edit's prepare and its
// asynchronous confirm. Rereading the binding then looks the intent up in the wrong outbox, so the
// saved edit silently never ships.
test('a commit confirms into the binding it was prepared on after the backend is replaced', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-commit-binding-'));
  const configPath = join(home, 'config.jsonc');
  const before = { providers: {} };
  const after = { providers: { work: { kind: 'api', baseUrl: 'https://example.test' } } };
  writeFileSync(configPath, encodeCandidate(after, configPath));
  const db = openDb({ home });
  try {
    const repo = createSyncRepository(db.sqlite);
    const port = (raw: Record<string, JsonValue>): LocalCommitPort => ({
      withFence: (run) => run(),
      rawDigest: async () => createHash('sha256').update(encodeCandidate(raw, configPath)).digest('hex'),
      accountOperationsSettled: () => true,
      committedSource: async () => ({
        raw,
        accounts: new Map(),
        pluginSecrets: new Map(),
        pluginVersions: new Map(),
      }),
    });
    let active = 'binding-a';
    const integration = {
      syncRepository: repo,
      preparedCommits: new Map(),
      configPath,
      get syncBinding() {
        return { id: active };
      },
      get syncPort() {
        return port(active === 'binding-a' ? after : before);
      },
    } as unknown as Parameters<typeof syncCommitOption>[0];

    const hooks = syncCommitOption(integration)!;
    const commitId = hooks.prepare(before, after);
    expect(repo.pendingCommits('binding-a')).toHaveLength(1);

    active = 'binding-b';
    await hooks.confirm(commitId);

    expect(repo.pendingCommits('binding-a')).toEqual([]);
    expect(repo.latestConfirmedCommit('binding-a')?.commitId).toBe(commitId);
  } finally {
    db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// An OAuth login writes this row's ownership outside the commit fence, so the preview snapshot the
// user reviewed is already stale. Persisting the pinned paths from that snapshot reinstates the
// superseded `oauth.localRevision`, and the next credential read rejects the Provider as
// `detach-pending`.
test('pinning a path keeps ownership a login recorded after the preview', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-overrides-'));
  const fixture = candidateFixture(
    home,
    () => Promise.resolve({ keys: [] }),
    {},
    {
      providers: { work: { kind: 'api', baseUrl: 'https://work.example.test' } },
    },
  );
  try {
    const candidate = await fixture.integration.connectBackend({ plugin: 'p', capability: 'c', options: {} });
    await candidate.commit();
    const repo = createSyncRepository(fixture.db.sqlite);
    const bindingId = repo.readBinding()!.id;
    // The connect wrote the binding pending; a reviewed connect apply is what clears it, and until it
    // does the control plane refuses every other preview.
    repo.setConnectPending!(bindingId, false);
    const row = repo.entities(bindingId).find((entity) => entity.logicalKey === 'work')!;
    const plane = createSyncControlPlaneIntegration(
      {
        manager: { current: () => ({ plugins: { registry: {} } }) },
        repository: createPluginRepository(fixture.db.sqlite),
      } as unknown as ServerRuntime,
      fixture.integration,
      { get: () => undefined } as never,
    )!;

    const preview = await plane.preview({ kind: 'overrides', objectId: row.objectId, paths: [['baseUrl']] });
    const oauth = {
      mode: 'shared',
      epoch: 0,
      generation: 0,
      localRevision: 7,
      pluginVersion: '1.0.0',
      formatVersion: 1,
    } as const;
    repo.putEntity(bindingId, { ...row, oauth });
    // The publication itself needs a backend this fixture's session does not implement; the pinned
    // paths are written before it, which is the whole window this guards.
    await plane
      .apply({ previewId: preview.previewId, decisions: [{ objectId: row.objectId, choice: 'local' }] })
      .catch(() => {});

    const latest = repo.entities(bindingId).find((entity) => entity.objectId === row.objectId)!;
    expect(latest.overrides).toEqual([{ path: ['baseUrl'], value: 'https://work.example.test' }]);
    expect(latest.oauth).toEqual(oauth);
  } finally {
    fixture.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// A reviewed decision substitutes for destination approval, not for a prerequisite this device
// cannot meet. An unresolved `{{env.NAME}}` resolves to an empty string, so importing the cloud body
// would commit an unauthenticated Provider — and the joined row then carries the cloud baseline with
// no pending reason, the one state reconciliation skips instead of retrying once the variable exists.
test('a reviewed cloud import stops at an environment reference this device cannot resolve', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-reviewed-env-'));
  const body = {
    kind: 'provider' as const,
    logicalKey: 'work',
    value: { kind: 'api', baseUrl: 'https://work.example.test', apiKey: '{{env.AIO_PROXY_TEST_ABSENT}}' },
    dependencies: [],
  };
  const fixture = candidateFixture(home, () => Promise.resolve({ keys: [entityKey('object-cloud')] }), {
    [entityKey('object-cloud')]: publish(reserve(newHead('object-cloud', body), 'op-1', 0), 'op-1', 0) as never,
    [revisionKey('object-cloud', 'op-1')]: {
      protocol: 1,
      state: 'payload',
      objectId: 'object-cloud',
      epoch: 0,
      operationId: 'op-1',
      body,
      publishedSequence: 1,
      writtenAt: 1,
    } as never,
  });
  try {
    const candidate = await fixture.integration.connectBackend({ plugin: 'p', capability: 'c', options: {} });
    await candidate.commit();
    const repo = createSyncRepository(fixture.db.sqlite);
    repo.setConnectPending!(repo.readBinding()!.id, false);
    let imported = 0;
    const plane = createSyncControlPlaneIntegration(
      {
        manager: { current: () => ({ plugins: { registry: {} } }) },
        repository: createPluginRepository(fixture.db.sqlite),
      } as unknown as ServerRuntime,
      {
        ...fixture.integration,
        // Counting the import is the assertion; the configuration write it would make needs a
        // runtime this fixture does not build.
        syncPort: {
          ...fixture.integration.syncPort!,
          applyRemote: () => {
            imported += 1;
            return Promise.resolve({ applied: true });
          },
        },
      } as unknown as ReturnType<typeof createSyncIntegration>,
      { get: () => undefined } as never,
    )!;
    const preview = await plane.preview({ kind: 'join', providerId: 'work' });

    await expect(
      plane.apply({
        previewId: preview.previewId,
        decisions: preview.rows.map((row) => ({ objectId: row.objectId, choice: 'cloud' as const })),
      }),
    ).rejects.toThrow('operation-pending');

    expect(imported).toBe(0);
  } finally {
    fixture.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});

// A stalled backend read inside `share()`/`detach()` keeps holding the Provider gate, so an orphaned
// signal lets a disconnect or a shutdown leave every later login and refresh for that Provider stuck.
test('account sharing work is cancelled by the lifecycle that owns it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-share-signal-'));
  const fixture = candidateFixture(home, () => Promise.resolve({ keys: [] }));
  try {
    const candidate = await fixture.integration.connectBackend({ plugin: 'p', capability: 'c', options: {} });
    await candidate.commit();
    const lifecycle = fixture.integration.lifecycle!;
    expect(lifecycle.signal.aborted).toBe(false);

    let captured: AbortSignal | undefined;
    const plane = createSyncControlPlaneIntegration(
      {
        manager: { current: () => ({ plugins: { registry: {} } }) },
        repository: { readAccount: () => ({ providerId: 'person', plugin: 'p', capability: 'c' }) },
      } as unknown as ServerRuntime,
      {
        ...fixture.integration,
        sharing: () => ({
          detach: (_providerId: string, _account: unknown, signal: AbortSignal) => {
            captured = signal;
            // A backend call that never settles: only cancellation can end it.
            return new Promise<void>(() => {});
          },
        }),
      } as unknown as ReturnType<typeof createSyncIntegration>,
      { get: () => ({ status: 'succeeded', providerId: 'person' }) } as never,
    )!;
    void plane.detach('person', 'login-1').catch(() => {});
    await Promise.resolve();

    expect(captured?.aborted).toBe(false);
    await lifecycle.close();
    expect(captured?.aborted).toBe(true);
  } finally {
    fixture.db.close();
    rmSync(home, { recursive: true, force: true });
  }
});
