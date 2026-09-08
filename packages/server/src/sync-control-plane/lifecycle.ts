import { mkdir, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  confirmLocalCommit,
  createSyncEngine,
  recoverLocalCommits,
  type JsonValue,
  type PluginRegistry,
  type PluginRepository,
  type SyncRepository,
} from '@aio-proxy/core';
import type { SyncSession } from '@aio-proxy/plugin-sdk';

import type { FifoQueue } from '../fifo-queue';
import type { LocalPortInput } from './local-port';
import { createLocalSyncPort } from './local-port';

export interface ServerSyncLifecycle {
  start(): Promise<void>;
  abort(): void;
  close(): Promise<void>;
  onCommitted(input: { commitId: string; origin: 'local' | 'remote' }): Promise<void>;
}

export type ServerSyncLifecycleInput = {
  readonly configPath: string;
  readonly configFile?: NonNullable<LocalPortInput['configFile']>;
  readonly repo: SyncRepository;
  readonly accounts: PluginRepository;
  readonly registry: () => PluginRegistry;
  readonly enqueue: FifoQueue;
  readonly applyCandidate: (raw: Record<string, JsonValue>, origin: 'local' | 'remote') => Promise<void>;
  readonly pluginVersions?: () => ReadonlyMap<string, string>;
  readonly localPort?: ReturnType<typeof createLocalSyncPort>;
};

export function createServerSyncLifecycle(input: ServerSyncLifecycleInput): ServerSyncLifecycle {
  const controller = new AbortController();
  let engine: ReturnType<typeof createSyncEngine> | undefined;
  let session: SyncSession | undefined;
  let port: ReturnType<typeof createLocalSyncPort> | undefined;
  let bindingId: string | undefined;
  let bindingGeneration: number | undefined;
  let started = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;

  function abort(): void {
    if (closed) return;
    controller.abort();
    engine?.stop().catch(() => {});
  }

  async function start(): Promise<void> {
    if (started || closed) return;
    started = true;
    const binding = input.repo.readBinding();
    if (binding === null) return;
    bindingId = binding.id;
    bindingGeneration = binding.sessionGeneration;
    const backend = input.registry().resolveSync(binding.plugin, binding.capability);
    if (backend === undefined) return;
    const configFile = input.configFile;
    if (configFile === undefined) return;
    const dataDirectory = join(dirname(input.configPath), '.sync', binding.id);
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    await chmod(dataDirectory, 0o700);
    port =
      input.localPort ??
      createLocalSyncPort({
        configPath: input.configPath,
        configFile,
        repo: input.repo,
        accounts: input.accounts,
        bindingId: binding.id,
        bindingGeneration: binding.sessionGeneration,
        enqueue: input.enqueue,
        registry: input.registry,
        applyCandidate: input.applyCandidate,
        pluginVersions: input.pluginVersions,
      });
    await recoverLocalCommits(input.repo, binding.id, port);
    let connected: SyncSession | undefined;
    try {
      connected = await backend.connect(binding.options, { signal: controller.signal, dataDirectory });
      const current = input.repo.readBinding();
      if (
        closed ||
        current === null ||
        current.id !== binding.id ||
        current.sessionGeneration !== binding.sessionGeneration ||
        connected.identityId !== binding.identityId ||
        connected.spaceId !== binding.spaceId
      ) {
        await connected.dispose().catch(() => {});
        connected = undefined;
        return;
      }
      session = connected;
      engine = createSyncEngine({
        binding,
        session,
        repo: input.repo,
        local: port,
        onStatus: () => {},
      });
      engine.start();
    } catch (error) {
      if (engine !== undefined) {
        await engine.stop().catch(() => {});
        engine = undefined;
      } else if (connected !== undefined) {
        await connected.dispose().catch(() => {});
      }
      session = undefined;
      throw error;
    }
  }

  async function onCommitted(commit: { commitId: string; origin: 'local' | 'remote' }): Promise<void> {
    if (port === undefined || closed) return;
    const current = input.repo.readBinding();
    if (current === null || current.id !== bindingId || current.sessionGeneration !== bindingGeneration) {
      throw new Error('The synchronization binding is stale');
    }
    await confirmLocalCommit(input.repo, current.id, commit.commitId, port);
    if (commit.origin === 'local') await engine?.reconcile(controller.signal);
  }

  function close(): Promise<void> {
    if (closePromise !== undefined) return closePromise;
    closed = true;
    controller.abort();
    closePromise = (async () => {
      await engine?.stop();
      engine = undefined;
      session = undefined;
      port = undefined;
    })();
    return closePromise;
  }

  return { start, abort, close, onCommitted };
}
