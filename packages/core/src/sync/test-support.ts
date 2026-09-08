import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SyncBackendError, type SyncCAS, type SyncRead, type SyncSession } from '@aio-proxy/plugin-sdk';

import { openDb } from '../db';
import { MIGRATIONS } from '../db/migrations.manifest';
import { DatabaseSchemaTooNewError } from '../error';
import { AtomicConfigFile } from '../plugins/config-file';
import { encodeCandidate } from '../plugins/config-file/serialization';
import type { StoredAccount } from '../plugins/repository';
import { createSyncEngine, type LocalSyncPort, type SyncEngine } from './engine';
import type { LocalCommitPort } from './local-commit';
import { confirmLocalCommit, prepareLocalCommit } from './local-commit';
import type { CommittedSource } from './projection';
import type { EntityKind } from './protocol';
import type { JsonValue } from './protocol';
import { createSyncRepository, type CommitIntent, type LocalEntity, type SyncRepository } from './repository';

export function includedEntity(objectId: string, kind: EntityKind, logicalKey: string): LocalEntity {
  return {
    objectId,
    logicalKey,
    kind,
    mode: 'included',
    epoch: 0,
    desired: null,
    baseline: null,
    overrides: [],
    pendingReason: null,
  };
}

export function storedAccount(providerId: string, token: string): StoredAccount {
  return {
    providerId,
    plugin: '@example/business',
    capability: 'first',
    fingerprint: providerId,
    options: {},
    secrets: {},
    credential: { token },
    revision: 1,
    runtimeRevision: 1,
    updatedAt: 0,
  };
}

export type SyncCommitFixture = {
  configPath: string;
  repo: SyncRepository;
  readonly bindingId: string;
  readonly intent: Omit<CommitIntent, 'phase'>;
  readonly port: LocalCommitPort;
  readonly control: {
    readonly fenceCalls: () => number;
    readonly setFence: (fence: LocalCommitPort['withFence']) => void;
    readonly setAccountOperationsSettled: (settled: boolean) => void;
    readonly setSourceRevisions: (revisions: Readonly<Record<string, number>> | undefined) => void;
    readonly reopen: () => SyncRepository;
  };
};

function digestConfig(value: Record<string, JsonValue>, path: string): string {
  return createHash('sha256').update(encodeCandidate(value, path)).digest('hex');
}

export async function withSyncCommitFixture(run: (fixture: SyncCommitFixture) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'aio-proxy-sync-commit-'));
  const configPath = join(dir, 'config.jsonc');
  const before = { providers: {} } satisfies Record<string, JsonValue>;
  const rawAfter = {
    providers: { work: { kind: 'api', baseUrl: 'https://example.test' } },
  } satisfies Record<string, JsonValue>;
  writeFileSync(configPath, encodeCandidate(before, configPath), { mode: 0o640 });
  let db = openDb({ home: dir });
  try {
    let repo = createSyncRepository(db.sqlite);
    const bindingId = 'binding-local-commit';
    repo.writeBinding({
      id: bindingId,
      plugin: '@example/sync',
      capability: 'memory',
      pluginVersion: '1.0.0',
      identityId: 'identity-local-commit',
      spaceId: 'default',
      deviceId: 'device-local-commit',
      sessionGeneration: 1,
      options: {},
    });
    repo.putEntity(bindingId, {
      objectId: 'provider-work',
      logicalKey: 'work',
      kind: 'provider',
      mode: 'included',
      epoch: 0,
      desired: null,
      baseline: null,
      overrides: [],
      pendingReason: null,
    });
    const file = new AtomicConfigFile(configPath);
    let fenceCalls = 0;
    let fence: LocalCommitPort['withFence'] = async <T>(action: () => Promise<T>) => action();
    let accountOperationsSettled = true;
    let sourceRevisions: Readonly<Record<string, number>> | undefined;
    const control = {
      fenceCalls: () => fenceCalls,
      setFence(next: LocalCommitPort['withFence']) {
        fence = next;
      },
      setAccountOperationsSettled(settled: boolean) {
        accountOperationsSettled = settled;
      },
      setSourceRevisions(revisions: Readonly<Record<string, number>> | undefined) {
        sourceRevisions = revisions;
      },
      reopen() {
        db.close();
        db = openDb({ home: dir });
        repo = createSyncRepository(db.sqlite);
        return repo;
      },
    };
    const intent = {
      commitId: 'local-commit',
      origin: 'local' as const,
      beforeDigest: digestConfig(before, configPath),
      afterDigest: digestConfig(rawAfter, configPath),
      rawAfter,
      accountOperationIds: [],
    } satisfies Omit<CommitIntent, 'phase'>;
    const port: LocalCommitPort = {
      async withFence<T>(action: () => Promise<T>) {
        fenceCalls++;
        return fence(action);
      },
      async rawDigest() {
        return digestConfig((await file.read()) as Record<string, JsonValue>, configPath);
      },
      accountOperationsSettled(ids) {
        return ids.length === 0 || accountOperationsSettled;
      },
      async committedSource(): Promise<CommittedSource> {
        return {
          raw: (await file.read()) as Record<string, JsonValue>,
          accounts: new Map(),
          pluginSecrets: new Map(),
          pluginVersions: new Map(),
          ...(sourceRevisions === undefined ? {} : { sourceRevisions }),
        };
      },
    };
    await run({ configPath, repo, bindingId, intent, port, control });
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function migrateSyncTestDb(sqlite: Database): void {
  const currentVersion = Number(Object.values(sqlite.query('PRAGMA user_version').get() ?? {}).at(0) ?? 0);
  const compiledVersion = MIGRATIONS.at(-1)?.version ?? 0;
  if (currentVersion > compiledVersion) throw new DatabaseSchemaTooNewError(currentVersion, compiledVersion);
  for (const migration of MIGRATIONS) {
    if (migration.version <= currentVersion) continue;
    const actualSha256 = createHash('sha256').update(migration.sql).digest('hex');
    if (actualSha256 !== migration.sha256) throw new Error(`Migration hash mismatch: ${migration.file}`);
    sqlite.transaction(() => {
      sqlite.run(migration.sql);
      sqlite.run(`PRAGMA user_version = ${migration.version}`);
    })();
  }
}

type Method = 'read' | 'compareAndSwap';
type FaultMode = 'before' | 'after';
type Gate = { readonly entered: Promise<void>; readonly release: () => void; readonly wait: () => Promise<void> };

export type MemorySyncBackend = {
  readonly connect: () => SyncSession;
  readonly readAll: () => ReadonlyMap<string, SyncRead>;
  readonly advance: (ms: number) => void;
  readonly failNext: (method: Method, mode: FaultMode) => void;
  readonly gateNext: (method: Method) => { readonly entered: Promise<void>; readonly release: () => void };
  readonly gateAfterNext: (method: Method) => { readonly entered: Promise<void>; readonly release: () => void };
};

function createGate(): Gate {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    async wait() {
      enter();
      await waiting;
    },
  };
}

async function waitForGate(gate: Gate, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(new SyncBackendError('cancelled', 'Sync operation was cancelled'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    void gate.wait().then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function casMemory(
  values: Map<string, Extract<SyncRead, { kind: 'present' }>>,
  key: string,
  expected: string | null,
  value: Uint8Array,
  nextVersion: () => string,
  modifiedAt: number,
): SyncCAS {
  const current = values.get(key);
  if ((current?.version ?? null) !== expected) return { kind: 'conflict' };
  const version = nextVersion();
  values.set(key, { kind: 'present', version, value: value.slice(), modifiedAt });
  return { kind: 'written', version, modifiedAt };
}

export function createMemorySyncBackend(): MemorySyncBackend {
  const values = new Map<string, Extract<SyncRead, { kind: 'present' }>>();
  const faults = new Map<Method, FaultMode>();
  const gates = new Map<Method, Gate>();
  const afterGates = new Map<Method, Gate>();
  let clock = 0;
  let version = 0;

  function nextVersion(): string {
    version++;
    return `v${version}`;
  }

  async function before(
    method: Method,
    signal: AbortSignal,
    sessionSignal: AbortSignal,
  ): Promise<FaultMode | undefined> {
    if (signal.aborted || sessionSignal.aborted)
      throw new SyncBackendError('cancelled', 'Sync operation was cancelled');
    const gate = gates.get(method);
    gates.delete(method);
    if (gate !== undefined) await waitForGate(gate, sessionSignal);
    if (signal.aborted || sessionSignal.aborted)
      throw new SyncBackendError('cancelled', 'Sync operation was cancelled');
    const fault = faults.get(method);
    faults.delete(method);
    if (fault === 'before') throw new SyncBackendError('offline', 'Sync backend is unavailable');
    return fault;
  }

  function connect(): SyncSession {
    let disposed = false;
    const sessionController = new AbortController();
    function assertOpen() {
      if (disposed || sessionController.signal.aborted) {
        throw new SyncBackendError('cancelled', 'Sync session is disposed');
      }
    }
    return {
      identityId: 'memory-identity',
      spaceId: 'default',
      maxValueBytes: Number.MAX_SAFE_INTEGER,
      async read(key, signal) {
        assertOpen();
        const fault = await before('read', signal, sessionController.signal);
        assertOpen();
        const current = values.get(key);
        const result: SyncRead =
          current === undefined ? { kind: 'absent' } : { ...current, value: current.value.slice() };
        const afterGate = afterGates.get('read');
        afterGates.delete('read');
        if (afterGate !== undefined) await waitForGate(afterGate, sessionController.signal);
        assertOpen();
        if (fault === 'after') throw new SyncBackendError('outcome-unknown', 'Sync read outcome is unknown');
        return result;
      },
      async compareAndSwap(key, expected, value, signal) {
        assertOpen();
        const fault = await before('compareAndSwap', signal, sessionController.signal);
        assertOpen();
        const result = casMemory(values, key, expected, value, nextVersion, clock);
        const afterGate = afterGates.get('compareAndSwap');
        afterGates.delete('compareAndSwap');
        if (afterGate !== undefined) await waitForGate(afterGate, sessionController.signal);
        assertOpen();
        if (fault === 'after') throw new SyncBackendError('outcome-unknown', 'Sync write outcome is unknown');
        return result;
      },
      async list(input, signal) {
        assertOpen();
        if (signal.aborted || sessionController.signal.aborted) {
          throw new SyncBackendError('cancelled', 'Sync operation was cancelled');
        }
        const keys = [...values.keys()].filter((key) => key.startsWith(input.prefix)).sort();
        const offset = input.cursor === undefined ? 0 : Number(input.cursor);
        if (!Number.isInteger(offset) || offset < 0)
          throw new SyncBackendError('invalid-data', 'Invalid memory cursor');
        const pageSize = 2;
        const page = keys.slice(offset, offset + pageSize);
        const nextOffset = offset + page.length;
        return { keys: page, ...(nextOffset < keys.length ? { nextCursor: String(nextOffset) } : {}) };
      },
      async remove(key, expected, signal) {
        assertOpen();
        if (signal.aborted || sessionController.signal.aborted) {
          throw new SyncBackendError('cancelled', 'Sync operation was cancelled');
        }
        const current = values.get(key);
        if (current === undefined || current.version !== expected) return { kind: 'conflict' };
        values.delete(key);
        return { kind: 'removed' };
      },
      async dispose() {
        disposed = true;
        sessionController.abort();
      },
    };
  }

  return {
    connect,
    readAll() {
      return new Map([...values].map(([key, value]) => [key, { ...value, value: value.value.slice() }] as const));
    },
    advance(ms) {
      clock += ms;
    },
    failNext(method, mode) {
      faults.set(method, mode);
    },
    gateNext(method) {
      const gate = createGate();
      gates.set(method, gate);
      return { entered: gate.entered, release: gate.release };
    },
    gateAfterNext(method) {
      const gate = createGate();
      afterGates.set(method, gate);
      return { entered: gate.entered, release: gate.release };
    },
  };
}

type TwoDevice = {
  readonly repo: SyncRepository;
  readonly binding: ReturnType<typeof twoDeviceBinding>;
  readonly engine: SyncEngine;
  readonly signal: AbortSignal;
  readonly commitProvider: (id: string, body: JsonValue, included: boolean) => Promise<void>;
};

function twoDeviceBinding(deviceId: string) {
  return {
    id: `binding-${deviceId}`,
    plugin: '@example/sync',
    capability: 'memory',
    pluginVersion: '1.0.0',
    identityId: 'memory-identity',
    spaceId: 'default' as const,
    deviceId,
    sessionGeneration: 1,
    options: {},
  };
}

/** A deterministic two-device fixture used by the backend-neutral engine tests. */
export async function withTwoSyncDevices(
  run: (devices: { a: TwoDevice; b: TwoDevice }) => Promise<void>,
): Promise<void> {
  const backend = createMemorySyncBackend();
  const homes = [mkdtempSync(join(tmpdir(), 'aio-proxy-sync-a-')), mkdtempSync(join(tmpdir(), 'aio-proxy-sync-b-'))];
  const databases = homes.map((home) => openDb({ home }));
  const sessions = [backend.connect(), backend.connect()];
  const devices: TwoDevice[] = [];
  try {
    for (const [index, database] of databases.entries()) {
      const deviceId = index === 0 ? 'device-a' : 'device-b';
      const binding = twoDeviceBinding(deviceId);
      const repo = createSyncRepository(database.sqlite);
      repo.writeBinding(binding);
      const raw: Record<string, JsonValue> = { providers: {} };
      const signal = new AbortController().signal;
      let commitNumber = 0;
      const local: LocalSyncPort = {
        async withFence<T>(action: () => Promise<T>) {
          return action();
        },
        async rawDigest() {
          return digestConfig(raw, join(homes[index]!, 'config.jsonc'));
        },
        accountOperationsSettled(ids) {
          return ids.length === 0;
        },
        async committedSource() {
          return { raw, accounts: new Map(), pluginSecrets: new Map(), pluginVersions: new Map() };
        },
        async applyRemote(objectId, body) {
          if (body === null) {
            const providers = raw['providers'];
            if (providers !== null && typeof providers === 'object' && !Array.isArray(providers)) {
              delete (providers as Record<string, JsonValue>)[objectId.replace(/^provider-/, '')];
            }
            return { applied: true };
          }
          if (body.kind !== 'provider') return { applied: false, pending: 'invalid-config' };
          const providers = raw['providers'];
          if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) {
            raw['providers'] = {};
          }
          (raw['providers'] as Record<string, JsonValue>)[body.logicalKey] = body.value;
          return { applied: true };
        },
      };
      const engine = createSyncEngine({ binding, session: sessions[index]!, repo, local, onStatus() {} });
      devices.push({
        repo,
        binding,
        engine,
        signal,
        async commitProvider(id, body, included) {
          const before = JSON.parse(JSON.stringify(raw)) as Record<string, JsonValue>;
          (raw['providers'] as Record<string, JsonValue>)[id] = body;
          const objectId = `provider-${id}`;
          repo.putEntity(binding.id, {
            objectId,
            logicalKey: id,
            kind: 'provider',
            mode: included ? 'included' : 'excluded',
            epoch: 0,
            desired: null,
            baseline: null,
            overrides: [],
            pendingReason: null,
          });
          const commitId = `${deviceId}-commit-${++commitNumber}`;
          prepareLocalCommit(repo, binding.id, {
            commitId,
            origin: 'local',
            beforeDigest: digestConfig(before, join(homes[index]!, 'config.jsonc')),
            afterDigest: digestConfig(raw, join(homes[index]!, 'config.jsonc')),
            rawAfter: raw,
            accountOperationIds: [],
          });
          await confirmLocalCommit(repo, binding.id, commitId, local);
        },
      });
    }
    await run({ a: devices[0]!, b: devices[1]! });
  } finally {
    await Promise.allSettled(devices.map((device) => device.engine.stop()));
    for (const database of databases) database.close();
    for (const home of homes) rmSync(home, { recursive: true, force: true });
  }
}
