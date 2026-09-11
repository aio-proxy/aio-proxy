import { mkdir, chmod } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  confirmLocalCommit,
  createSyncEngine,
  recoverLocalCommits,
  createSharedOAuthCoordinator,
  createOAuthSharingService,
  createSyncObjectStore,
  type JsonValue,
  type LocalBinding,
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
  activate(): void;
  reconcile(): Promise<void>;
  abort(): void;
  close(): Promise<void>;
  onCommitted(input: { commitId: string; origin: 'local' | 'remote' }): Promise<void>;
  session(): SyncSession | undefined;
}

export type ServerSyncLifecycleInput = {
  readonly deferEngine?: boolean;
  readonly initialBinding?: LocalBinding;
  readonly preconnectedSession?: SyncSession;
  readonly configPath: string;
  readonly configFile?: NonNullable<LocalPortInput['configFile']>;
  readonly repo: SyncRepository;
  readonly accounts: PluginRepository;
  readonly registry: () => PluginRegistry;
  readonly enqueue: FifoQueue;
  readonly applyCandidate: (
    raw: Record<string, JsonValue>,
    origin: 'local' | 'remote',
    operationId?: string,
    pluginSecret?: { readonly plugin: string; readonly value: JsonValue | undefined },
    expectedDigest?: string,
  ) => Promise<void>;
  readonly pluginVersions?: () => ReadonlyMap<string, string>;
  readonly localPort?: ReturnType<typeof createLocalSyncPort>;
  readonly onCoordinator?: (coordinator: import('@aio-proxy/core').SharedOAuthCoordinator | undefined) => void;
  readonly onSharing?: (sharing: import('@aio-proxy/core').OAuthSharingService | undefined) => void;
  readonly withProviderGate?: <T>(providerId: string, run: () => Promise<T>) => Promise<T>;
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
    let connected: SyncSession | undefined = input.preconnectedSession;
    try {
      const binding = input.initialBinding ?? input.repo.readBinding();
      if (binding === null) {
        if (input.initialBinding !== undefined) throw new Error('Synchronization binding is missing');
        return;
      }
      bindingId = binding.id;
      bindingGeneration = binding.sessionGeneration;
      const backend = input.registry().resolveSync(binding.plugin, binding.capability);
      if (backend === undefined) {
        if (input.initialBinding !== undefined) throw new Error('Synchronization backend is unavailable');
        return;
      }
      const configFile = input.configFile;
      if (configFile === undefined) {
        if (input.initialBinding !== undefined) throw new Error('Synchronization config is unavailable');
        return;
      }
      const parsedOptions = backend.options.schema.safeParse(binding.options);
      if (!parsedOptions.success) {
        if (input.initialBinding !== undefined) throw new Error('Invalid synchronization backend options');
        return;
      }
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
      connected ??= await backend.connect(parsedOptions.data, { signal: controller.signal, dataDirectory });
      const current = input.repo.readBinding();
      const currentBindingMismatch =
        input.initialBinding === undefined &&
        (current === null || current.id !== binding.id || current.sessionGeneration !== binding.sessionGeneration);
      const sessionMismatch = connected.identityId !== binding.identityId || connected.spaceId !== binding.spaceId;
      if (closed || currentBindingMismatch || sessionMismatch) {
        await connected.dispose().catch(() => {});
        connected = undefined;
        if (!closed && input.initialBinding !== undefined && sessionMismatch)
          throw new Error('Synchronization session does not match binding');
        return;
      }
      session = connected;
      const store = createSyncObjectStore(connected);
      input.onCoordinator?.(createSharedOAuthCoordinator({ binding, store, repo: input.repo }));
      const sharing = createOAuthSharingService({
        binding,
        repo: input.repo,
        accounts: input.accounts,
        store,
        resolveAdapter(providerId) {
          const account = input.accounts.readAccount(providerId);
          if (account === null) throw new Error('SYNC_OAUTH_ACCOUNT_MISSING');
          const adapter = input.registry().resolveOAuth(account.plugin, account.capability);
          const pluginVersion = input.pluginVersions?.().get(account.plugin);
          if (adapter === undefined || pluginVersion === undefined) throw new Error('SYNC_OAUTH_UPGRADE_REQUIRED');
          return { adapter, pluginVersion };
        },
        withProviderGate: input.withProviderGate ?? (async (_providerId, run) => run()),
      });
      input.onSharing?.(sharing);
      await sharing.recover(controller.signal);
      engine = createSyncEngine({
        binding,
        session,
        repo: input.repo,
        local: port,
        onStatus: () => {},
      });
      if (!input.deferEngine) engine.start();
    } catch (error) {
      if (engine !== undefined) {
        await engine.stop().catch(() => {});
        engine = undefined;
      } else if (connected !== undefined) {
        await connected.dispose().catch(() => {});
        connected = undefined;
      }
      session = undefined;
      input.onCoordinator?.(undefined);
      input.onSharing?.(undefined);
      // An explicit connect must surface its failure. Restoring a persisted binding must not:
      // a routine backend outage would otherwise abort server startup, taking model traffic and
      // the Dashboard recovery actions down with it. Every check above already returns instead
      // of throwing on that path. Stay unstarted so a later retry reconnects.
      if (input.initialBinding !== undefined) throw error;
      started = false;
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
      const currentEngine = engine;
      engine = undefined;
      try {
        await currentEngine?.stop();
      } finally {
        if (currentEngine === undefined) await session?.dispose().catch(() => {});
        session = undefined;
        input.onCoordinator?.(undefined);
        input.onSharing?.(undefined);
        port = undefined;
      }
    })();
    return closePromise;
  }

  async function reconcile(): Promise<void> {
    if (engine === undefined || closed) return;
    await engine.reconcile(controller.signal);
  }

  return {
    start,
    activate: () => {
      if (!closed) engine?.start();
    },
    reconcile,
    abort,
    close,
    onCommitted,
    session: () => session,
  };
}
