import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';

import { SyncBackendError, type SyncCAS, type SyncRead, type SyncSession } from '@aio-proxy/plugin-sdk';

import { MIGRATIONS } from '../db/migrations.manifest';

export function migrateSyncTestDb(sqlite: Database): void {
  const currentVersion = Number(Object.values(sqlite.query('PRAGMA user_version').get() ?? {}).at(0) ?? 0);
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
      spaceId: 'memory-space',
      maxValueBytes: Number.MAX_SAFE_INTEGER,
      async read(key, signal) {
        assertOpen();
        const fault = await before('read', signal, sessionController.signal);
        assertOpen();
        const current = values.get(key);
        const result: SyncRead =
          current === undefined ? { kind: 'absent' } : { ...current, value: current.value.slice() };
        if (fault === 'after') throw new SyncBackendError('outcome-unknown', 'Sync read outcome is unknown');
        return result;
      },
      async compareAndSwap(key, expected, value, signal) {
        assertOpen();
        const fault = await before('compareAndSwap', signal, sessionController.signal);
        assertOpen();
        const result = casMemory(values, key, expected, value, nextVersion, clock);
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
  };
}
