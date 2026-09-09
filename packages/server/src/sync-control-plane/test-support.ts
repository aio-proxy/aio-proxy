import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AtomicConfigFile,
  createPluginRepository,
  createSyncRepository,
  encodeCandidate,
  type BuiltInPluginDefinition,
  type EntityKind,
  type LocalBinding,
  type LocalEntity,
  type PluginRegistry,
  type PluginRepository,
  type SyncRepository,
} from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import {
  SyncBackendError,
  definePlugin,
  zod,
  type SyncBackendDefinition,
  type SyncRead,
  type SyncSession,
} from '@aio-proxy/plugin-sdk';
import { ConfigSchema } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

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
  readonly close: () => Promise<void>;
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
    async close() {
      await lifecycle.close();
      db.close();
      events.push('database-closed');
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function configDigest(raw: Record<string, unknown>, configPath: string): string {
  return createHash('sha256').update(encodeCandidate(raw, configPath)).digest('hex');
}

type AcceptanceMemoryValue = Extract<SyncRead, { kind: 'present' }>;

/**
 * A deterministic backend used by the product acceptance fixture. It is deliberately
 * small, but implements the same session boundary as a real plugin backend: each
 * server receives a separate session, while values and watch hints are shared.
 */
type AcceptanceMemoryBackend = {
  readonly definition: SyncBackendDefinition<Record<string, never>>;
  readonly readAll: () => ReadonlyMap<string, AcceptanceMemoryValue>;
  readonly poke: () => void;
  readonly setOnline: (online: boolean) => void;
  readonly setIdentity: (identityId: string) => void;
  readonly advance: (milliseconds: number) => void;
  readonly inject: (key: string, value: Uint8Array) => void;
};

function createAcceptanceMemoryBackend(): AcceptanceMemoryBackend {
  const values = new Map<string, AcceptanceMemoryValue>();
  let version = 0;
  let clock = Date.now();
  let online = true;
  let identityId = 'acceptance-memory-identity';

  function assertAvailable(sessionIdentity: string, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (!online) throw new SyncBackendError('offline', 'Acceptance backend is offline');
    if (identityId !== sessionIdentity) throw new SyncBackendError('identity-changed', 'Acceptance identity changed');
  }

  const definition: SyncBackendDefinition<Record<string, never>> = {
    id: 'memory',
    displayName: 'Acceptance memory',
    options: { schema: zod.object({}), form: [] },
    async connect() {
      const sessionIdentity = identityId;
      const session: SyncSession = {
        identityId: sessionIdentity,
        spaceId: 'default',
        maxValueBytes: 1_000_000,
        async read(key, signal) {
          assertAvailable(sessionIdentity, signal);
          const current = values.get(key);
          return current === undefined ? { kind: 'absent' as const } : { ...current, value: current.value.slice() };
        },
        async compareAndSwap(key, expected, value, signal) {
          assertAvailable(sessionIdentity, signal);
          const current = values.get(key);
          if ((current?.version ?? null) !== expected) return { kind: 'conflict' as const };
          const next: AcceptanceMemoryValue = {
            kind: 'present',
            value: value.slice(),
            version: String(++version),
            modifiedAt: clock,
          };
          values.set(key, next);
          return { kind: 'written' as const, version: next.version, modifiedAt: next.modifiedAt };
        },
        async list({ prefix }, signal) {
          assertAvailable(sessionIdentity, signal);
          return { keys: [...values.keys()].filter((key) => key.startsWith(prefix)) };
        },
        async remove(key, expected, signal) {
          assertAvailable(sessionIdentity, signal);
          if (values.get(key)?.version !== expected) return { kind: 'conflict' as const };
          values.delete(key);
          return { kind: 'removed' as const };
        },
        async dispose() {},
      };
      return session;
    },
  };
  return {
    definition,
    readAll: () => values,
    poke: () => {},
    setOnline(next) {
      online = next;
    },
    setIdentity(next) {
      identityId = next;
    },
    advance(milliseconds) {
      clock += milliseconds;
    },
    inject(key, value) {
      values.set(key, { kind: 'present', value: value.slice(), version: String(++version), modifiedAt: clock });
    },
  };
}

const ACCEPTANCE_PLUGIN = '@example/sync-acceptance';
const ACCEPTANCE_BINDING_PLUGIN_VERSION = '1.0.0';

function acceptanceDescriptor(backend: SyncBackendDefinition<Record<string, never>>): BuiltInPluginDefinition {
  return {
    packageName: ACCEPTANCE_PLUGIN,
    version: ACCEPTANCE_BINDING_PLUGIN_VERSION,
    descriptor: definePlugin(
      (api) => {
        api.sync.register(backend);
        api.oauth.register({
          id: 'acceptance-oauth',
          displayName: 'Acceptance OAuth',
          account: { options: { schema: zod.object({}), form: [] } },
          credentials: zod.object({ token: zod.string() }),
          async login() {
            throw new Error('acceptance OAuth login is not used by sync tests');
          },
          catalog: {
            policy: { kind: 'static' },
            async discover() {
              return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
            },
          },
          async createRuntime() {
            throw new Error('acceptance OAuth runtime is not used by sync tests');
          },
          credentialSync: {
            formatVersion: 1,
            multiDevice: { evidenceId: 'acceptance-oauth-evidence' },
            canDetach: async () => true,
          },
        });
      },
      {
        options: {
          schema: zod.object({ endpoint: zod.url().optional(), token: zod.string().optional() }),
          form: [
            { type: 'text', key: 'endpoint', label: 'Endpoint' },
            { type: 'secret', key: 'token', label: 'Token' },
          ],
        },
      },
    ),
  };
}

function acceptanceEntity(objectId: string, kind: EntityKind, logicalKey: string): LocalEntity {
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

type AcceptanceServer = {
  readonly configPath: string;
  readonly home: string;
  readonly providerMarker: string;
  readonly pluginMarker: string;
  readonly state: ReturnType<typeof createServerState> extends Promise<infer T> ? T : never;
  readonly reconcile: () => Promise<void>;
};

export type TwoServerSyncFixture = {
  readonly backend: AcceptanceMemoryBackend;
  readonly a: AcceptanceServer;
  readonly b: AcceptanceServer;
  readonly restart: (device: 'a' | 'b') => Promise<void>;
  readonly close: () => Promise<void>;
};

export type TwoServerSyncFixtureOptions = {
  readonly providerObjectIds?: Partial<Record<'a' | 'b', string>>;
};

/**
 * Open two real ServerState instances with independent homes and one shared
 * backend. Actions in acceptance tests go through ConfigStore, PluginControlPlane,
 * and SyncControlPlane; the repository is touched only while preparing durable
 * fixture state before a server starts.
 */
export async function withTwoServerSyncFixtures(
  run: (fixture: TwoServerSyncFixture) => Promise<void>,
  options: TwoServerSyncFixtureOptions = {},
): Promise<void> {
  const backend = createAcceptanceMemoryBackend();
  const descriptor = acceptanceDescriptor(backend.definition);
  const initialRaw = {
    plugins: [[ACCEPTANCE_PLUGIN, { endpoint: 'https://plugin.example.test' }]],
    providers: {},
  } satisfies Record<string, unknown>;
  const homes: string[] = [];
  const devices = new Map<'a' | 'b', AcceptanceServer>();

  const createDevice = async (
    device: 'a' | 'b',
    markers?: { provider: string; plugin: string },
    seedPluginSecret = false,
  ) => {
    const home = mkdtempSync(join(tmpdir(), `aio-proxy-sync-acceptance-${device}-`));
    homes.push(home);
    const configPath = join(home, 'config.jsonc');
    writeFileSync(configPath, encodeCandidate(initialRaw, configPath), { mode: 0o600 });
    const database = openDb({ home });
    const pluginRepository = createPluginRepository(database.sqlite);
    const repository = createSyncRepository(database.sqlite);
    const binding: LocalBinding = {
      id: `acceptance-binding-${device}`,
      plugin: ACCEPTANCE_PLUGIN,
      capability: 'memory',
      pluginVersion: ACCEPTANCE_BINDING_PLUGIN_VERSION,
      identityId: 'acceptance-memory-identity',
      spaceId: 'default',
      deviceId: `acceptance-device-${device}`,
      sessionGeneration: 1,
      options: {},
    };
    repository.writeBinding(binding);
    repository.putEntity(
      binding.id,
      acceptanceEntity(options.providerObjectIds?.[device] ?? 'provider-work', 'provider', 'work'),
    );
    repository.putEntity(binding.id, acceptanceEntity('plugin-shared', 'plugin-business', ACCEPTANCE_PLUGIN));
    repository.putEntity(binding.id, acceptanceEntity('model-shared', 'model-rule', 'shared-model'));
    if (markers !== undefined && seedPluginSecret)
      pluginRepository.writePluginSecret(ACCEPTANCE_PLUGIN, null, { token: markers.plugin });
    database.close();
    const providerMarker = markers?.provider ?? `provider-marker-${crypto.randomUUID()}`;
    const pluginMarker = markers?.plugin ?? `plugin-marker-${crypto.randomUUID()}`;
    const raw = (await new AtomicConfigFile(configPath).read()) as Record<string, unknown>;
    const state = await createServerState({
      config: ConfigSchema.parse(raw),
      configPath,
      dbHome: home,
      watchConfig: false,
      builtIns: [descriptor],
    });
    const server = {
      configPath,
      home,
      providerMarker,
      pluginMarker,
      state,
      async reconcile() {
        backend.poke();
        await state.sync?.retry();
      },
    } as AcceptanceServer;
    devices.set(device, server);
    return server;
  };

  const markers = {
    provider: `provider-marker-${crypto.randomUUID()}`,
    plugin: `plugin-marker-${crypto.randomUUID()}`,
  };
  await createDevice('a', markers, true);
  await createDevice('b', markers, false);
  const fixture = {
    backend,
    get a() {
      return devices.get('a')!;
    },
    get b() {
      return devices.get('b')!;
    },
    async restart(device: 'a' | 'b') {
      const current = devices.get(device);
      if (current === undefined) throw new Error(`unknown acceptance device: ${device}`);
      await current.state.closeAsync();
      const raw = (await new AtomicConfigFile(current.configPath).read()) as Record<string, unknown>;
      const state = await createServerState({
        config: ConfigSchema.parse(raw),
        configPath: current.configPath,
        dbHome: current.home,
        watchConfig: false,
        builtIns: [descriptor],
      });
      devices.set(device, {
        ...current,
        state,
        async reconcile() {
          backend.poke();
          await state.sync?.retry();
        },
      });
    },
    async close() {
      for (const server of [...devices.values()].reverse()) await server.state.closeAsync();
      for (const home of homes.reverse()) rmSync(home, { recursive: true, force: true });
    },
  } satisfies TwoServerSyncFixture;

  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
}

export const twoServerSyncAcceptancePlugin = ACCEPTANCE_PLUGIN;
