import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AtomicConfigFile,
  createSyncRepository,
  encodeCandidate,
  type PluginRegistry,
  type PluginRepository,
  type SyncRepository,
} from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import type { SyncBackendDefinition, SyncSession } from '@aio-proxy/plugin-sdk';

import { createFifoQueue, type FifoQueue } from '../fifo-queue';
import { createServerSyncLifecycle } from './lifecycle';
import { createLocalSyncPort } from './local-port';

type MemoryStore = Map<string, { value: Uint8Array; version: string; modifiedAt: number }>;

function memoryBackend(events: string[]): SyncBackendDefinition<Record<string, never>> & { connectCount(): number } {
  const values: MemoryStore = new Map();
  let version = 0;
  let connections = 0;
  return {
    id: 'memory',
    displayName: 'Memory',
    options: {
      schema: {
        safeParse: (value: unknown) => ({ success: value !== null && typeof value === 'object', data: value }),
      },
      form: [],
    } as never,
    connectCount: () => connections,
    async connect() {
      connections++;
      const session: SyncSession = {
        identityId: 'memory-identity',
        spaceId: 'default',
        maxValueBytes: 1_000_000,
        async read(key, signal) {
          signal.throwIfAborted();
          const current = values.get(key);
          return current === undefined
            ? { kind: 'absent' }
            : {
                kind: 'present',
                value: current.value.slice(),
                version: current.version,
                modifiedAt: current.modifiedAt,
              };
        },
        async compareAndSwap(key, expected, value, signal) {
          signal.throwIfAborted();
          const current = values.get(key);
          if ((current?.version ?? null) !== expected) return { kind: 'conflict' };
          const next = { value: value.slice(), version: String(++version), modifiedAt: Date.now() };
          values.set(key, next);
          return { kind: 'written', version: next.version, modifiedAt: next.modifiedAt };
        },
        async list({ prefix }, signal) {
          signal.throwIfAborted();
          return { keys: [...values.keys()].filter((key) => key.startsWith(prefix)) };
        },
        async remove(key, expected, signal) {
          signal.throwIfAborted();
          if (values.get(key)?.version !== expected) return { kind: 'conflict' };
          values.delete(key);
          return { kind: 'removed' };
        },
        async dispose() {
          events.push('disposed');
        },
      };
      events.push('connected');
      return session;
    },
  };
}

export type ServerSyncFixture = {
  readonly configPath: string;
  readonly repo: SyncRepository;
  readonly port: ReturnType<typeof createLocalSyncPort>;
  readonly accounts: PluginRepository;
  readonly events: () => readonly string[];
  readonly connectCount: () => number;
  readonly lifecycle: ReturnType<typeof createServerSyncLifecycle>;
  readonly close: () => void;
};

/** A small deterministic lifecycle fixture for tests that do not need the full server snapshot. */
export function createServerSyncFixture(input: {
  readonly accounts: PluginRepository;
  readonly registry: () => PluginRegistry;
  readonly config?: Record<string, unknown>;
}): ServerSyncFixture {
  const directory = mkdtempSync(join(tmpdir(), 'aio-proxy-server-sync-'));
  const configPath = join(directory, 'config.jsonc');
  const raw = input.config ?? { providers: {} };
  writeFileSync(configPath, encodeCandidate(raw, configPath));
  const db = openDb({ home: directory });
  const repo = createSyncRepository(db.sqlite);
  const events: string[] = [];
  const backend = memoryBackend(events);
  const registry = input.registry();
  const wrappedRegistry: PluginRegistry = { ...registry, resolveSync: () => backend, syncCapabilities: () => [] };
  repo.writeBinding({
    id: 'test-binding',
    plugin: '@example/sync',
    capability: 'memory',
    pluginVersion: '1.0.0',
    identityId: 'memory-identity',
    spaceId: 'default',
    deviceId: 'test-device',
    sessionGeneration: 1,
    options: {},
  });
  const file = new AtomicConfigFile(configPath);
  const queue: FifoQueue = createFifoQueue();
  const port = createLocalSyncPort({
    configPath,
    configFile: file,
    repo,
    accounts: input.accounts,
    bindingId: 'test-binding',
    enqueue: queue,
    registry: () => wrappedRegistry,
    applyCandidate: async (candidate) => file.replace(() => candidate),
  });
  const lifecycle = createServerSyncLifecycle({
    configPath,
    configFile: file,
    repo,
    accounts: input.accounts,
    registry: () => wrappedRegistry,
    enqueue: queue,
    localPort: port,
    applyCandidate: async (candidate) => file.replace(() => candidate),
  });
  return {
    configPath,
    repo,
    port,
    accounts: input.accounts,
    lifecycle,
    events: () => events,
    connectCount: backend.connectCount,
    close() {
      void lifecycle.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function configDigest(raw: Record<string, unknown>, configPath: string): string {
  return createHash('sha256').update(encodeCandidate(raw, configPath)).digest('hex');
}
