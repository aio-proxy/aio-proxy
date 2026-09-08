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
        enqueue: input.enqueue,
        registry: input.registry,
        applyCandidate: input.applyCandidate,
        pluginVersions: input.pluginVersions,
      });
    await recoverLocalCommits(input.repo, binding.id, port);
    session = await backend.connect(binding.options, { signal: controller.signal, dataDirectory });
    if (session.identityId !== binding.identityId || session.spaceId !== binding.spaceId) {
      await session.dispose();
      session = undefined;
      throw new Error('Sync backend identity does not match its local binding');
    }
    engine = createSyncEngine({
      binding,
      session,
      repo: input.repo,
      local: port,
      onStatus: () => {},
    });
    engine.start();
  }

  async function onCommitted(commit: { commitId: string; origin: 'local' | 'remote' }): Promise<void> {
    if (port === undefined || closed) return;
    await confirmLocalCommit(input.repo, input.repo.readBinding()?.id ?? '', commit.commitId, port);
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
