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
  encodeCandidate,
  type JsonValue,
  type LocalCommitPort,
  type PluginRegistrySnapshot,
} from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';

import type { ServerRuntime } from '../lifecycle';
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

function candidateFixture(home: string, list: (signal: AbortSignal) => Promise<{ keys: string[] }>) {
  const configPath = join(home, 'config.jsonc');
  writeFileSync(configPath, encodeCandidate({ providers: {} }, configPath));
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
    read: () => Promise.resolve({ kind: 'absent' as const }),
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
