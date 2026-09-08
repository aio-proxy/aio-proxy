import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SyncSession } from '@aio-proxy/plugin-sdk';

import { openDb } from '../../db';
import { AtomicConfigFile } from '../../plugins/config-file';
import { encodeCandidate } from '../../plugins/config-file/serialization';
import { confirmLocalCommit, prepareLocalCommit } from '../local-commit';
import type { JsonValue } from '../protocol';
import { createSyncRepository, type LocalBinding, type SyncRepository } from '../repository';
import { createMemorySyncBackend, type MemorySyncBackend } from '../test-support';
import { createSyncEngine, type SyncEngine } from './engine';
import type { LocalSyncPort } from './incoming';
import type { PendingReason } from './incoming';

function digestConfig(value: Record<string, JsonValue>, path: string): string {
  return createHash('sha256').update(encodeCandidate(value, path)).digest('hex');
}

type Method = 'read' | 'compareAndSwap';
type Gate = { readonly entered: Promise<void>; readonly release: () => void; readonly wait: () => Promise<void> };

function createGate(): Gate {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const waiting = new Promise<void>((resolve) => (release = resolve));
  return {
    entered,
    release,
    async wait() {
      enter();
      await waiting;
    },
  };
}

function bindingFor(deviceId: string): LocalBinding {
  return {
    id: `binding-${deviceId}`,
    plugin: '@example/sync',
    capability: 'memory',
    pluginVersion: '1.0.0',
    identityId: 'memory-identity',
    spaceId: 'default',
    deviceId,
    sessionGeneration: 1,
    options: {},
  };
}

export type TwoDevice = {
  readonly repo: SyncRepository;
  readonly binding: LocalBinding;
  readonly session: SyncSession;
  readonly engine: SyncEngine;
  readonly signal: AbortSignal;
  readonly commitProvider: (id: string, body: JsonValue, included: boolean) => Promise<void>;
  readonly queueDelete: (objectId: string, epoch: number) => void;
  readonly setPendingActivation: (reason: PendingReason | undefined) => void;
  readonly remoteApplyCalls: () => readonly { objectId: string; operationId: string; body: JsonValue | null }[];
  readonly gateNext: (method: Method) => { readonly entered: Promise<void>; readonly release: () => void };
  readonly pauseRemoteApplication: () => { readonly entered: Promise<void>; readonly release: () => void };
};

export async function withTwoSyncDevices(
  run: (devices: { a: TwoDevice; b: TwoDevice }) => Promise<void>,
): Promise<void> {
  const backend: MemorySyncBackend = createMemorySyncBackend();
  const homes = [mkdtempSync(join(tmpdir(), 'aio-proxy-sync-a-')), mkdtempSync(join(tmpdir(), 'aio-proxy-sync-b-'))];
  const configPaths = homes.map((home) => join(home, 'config.jsonc'));
  for (const path of configPaths) writeFileSync(path, encodeCandidate({ providers: {} }, path));
  const databases = homes.map((home) => openDb({ home }));
  const sessions = [backend.connect(), backend.connect()];
  const devices: TwoDevice[] = [];
  try {
    for (const [index, database] of databases.entries()) {
      const deviceId = index === 0 ? 'device-a' : 'device-b';
      const binding = bindingFor(deviceId);
      const repo = createSyncRepository(database.sqlite);
      repo.writeBinding(binding);
      const config = new AtomicConfigFile(configPaths[index]!);
      const signal = new AbortController().signal;
      let commitNumber = 0;
      let pendingActivation: PendingReason | undefined;
      let remoteGate: Gate | undefined;
      const remoteCalls: { objectId: string; operationId: string; body: JsonValue | null }[] = [];
      const local: LocalSyncPort = {
        async withFence<T>(action: () => Promise<T>) {
          return action();
        },
        async rawDigest() {
          return digestConfig((await config.read()) as Record<string, JsonValue>, configPaths[index]!);
        },
        accountOperationsSettled(ids) {
          return ids.length === 0;
        },
        async committedSource() {
          return {
            raw: (await config.read()) as Record<string, JsonValue>,
            accounts: new Map(),
            pluginSecrets: new Map(),
            pluginVersions: new Map(),
          };
        },
        async applyRemote(objectId, body, operationId) {
          remoteCalls.push({ objectId, operationId, body: body === null ? null : body.value });
          if (remoteGate !== undefined) await remoteGate.wait();
          if (pendingActivation !== undefined) return { applied: false, pending: pendingActivation };
          const before = (await config.read()) as Record<string, JsonValue>;
          const next = JSON.parse(JSON.stringify(before)) as Record<string, JsonValue>;
          const providers = next['providers'];
          if (body === null) {
            if (providers !== null && typeof providers === 'object' && !Array.isArray(providers)) {
              delete (providers as Record<string, JsonValue>)[objectId.replace(/^provider-/, '')];
            }
          } else {
            if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) next['providers'] = {};
            (next['providers'] as Record<string, JsonValue>)[body.logicalKey] = body.value;
          }
          const commitId = `remote-${objectId}-${operationId}`;
          prepareLocalCommit(repo, binding.id, {
            commitId,
            origin: 'remote',
            beforeDigest: digestConfig(before, configPaths[index]!),
            afterDigest: digestConfig(next, configPaths[index]!),
            rawAfter: next,
            accountOperationIds: [],
            remoteOperations: [{ objectId, operationId }],
          });
          await config.replace(async () => next, {
            afterCommit: async () => confirmLocalCommit(repo, binding.id, commitId, local),
          });
          return { applied: true };
        },
      };
      const engine = createSyncEngine({ binding, session: sessions[index]!, repo, local, onStatus() {}, pollMs: 5 });
      devices.push({
        repo,
        binding,
        session: sessions[index]!,
        engine,
        signal,
        setPendingActivation(reason) {
          pendingActivation = reason;
        },
        remoteApplyCalls() {
          return remoteCalls;
        },
        gateNext(method) {
          return backend.gateNext(method);
        },
        pauseRemoteApplication() {
          const gate = createGate();
          remoteGate = gate;
          return { entered: gate.entered, release: gate.release };
        },
        async commitProvider(id, body, included) {
          const before = (await config.read()) as Record<string, JsonValue>;
          const next = JSON.parse(JSON.stringify(before)) as Record<string, JsonValue>;
          const providers = next['providers'];
          if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) next['providers'] = {};
          (next['providers'] as Record<string, JsonValue>)[id] = body;
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
            beforeDigest: digestConfig(before, configPaths[index]!),
            afterDigest: digestConfig(next, configPaths[index]!),
            rawAfter: next,
            accountOperationIds: [],
          });
          await config.replace(async () => next, {
            afterCommit: async () => confirmLocalCommit(repo, binding.id, commitId, local),
          });
        },
        queueDelete(objectId, epoch) {
          const commitId = `${deviceId}-delete-${++commitNumber}`;
          prepareLocalCommit(repo, binding.id, {
            commitId,
            origin: 'local',
            beforeDigest: 'delete-before',
            afterDigest: 'delete-after',
            rawAfter: {},
            accountOperationIds: [],
          });
          repo.confirm(binding.id, commitId, [
            { operationId: `${commitId}-operation`, objectId, epoch, kind: 'delete', body: null, commitId },
          ]);
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
