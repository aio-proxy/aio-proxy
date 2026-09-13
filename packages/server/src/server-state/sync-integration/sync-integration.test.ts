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
  const integration = createSyncIntegration(
    { options: { configPath }, remoteConfigFence: undefined } as unknown as ServerRuntime,
    db,
    createPluginRepository(db.sqlite),
    () => ({ plugins: new Map(), registry }) as unknown as PluginRegistrySnapshot,
    new AtomicConfigFile(configPath),
    { configPath } as never,
    async <T>(run: () => Promise<T>) => run(),
  );
  return { db, integration, signals, disposed: () => disposed };
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
