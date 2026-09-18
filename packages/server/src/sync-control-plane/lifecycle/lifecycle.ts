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

import type { FifoQueue } from '../../fifo-queue';
import type { LocalPortInput } from '../local-port';
import { createLocalSyncPort } from '../local-port';

export interface ServerSyncLifecycle {
  start(): Promise<void>;
  activate(): void;
  reconcile(): Promise<void>;
  abort(): void;
  close(): Promise<void>;
  onCommitted(input: { commitId: string; origin: 'local' | 'remote' }): Promise<void>;
  session(): SyncSession | undefined;
  /** Aborted by `abort()` and `close()`, so backend work started for this binding cannot outlive it. */
  readonly signal: AbortSignal;
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
  /** Background reconciliation outcomes, so the public status reflects automatic synchronization. */
  readonly onStatus?: (status: string) => void;
  readonly withProviderGate?: <T>(providerId: string, run: () => Promise<T>) => Promise<T>;
};

function createSharing(
  input: ServerSyncLifecycleInput,
  binding: LocalBinding,
  store: ReturnType<typeof createSyncObjectStore>,
) {
  return createOAuthSharingService({
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
}

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
  // Consumed by the first start(): the session it hands over is disposed on every failure path, and a
  // reconnect must dial the backend again rather than install a dead session a second time.
  let preconnected = input.preconnectedSession;

  // The engine stops for good when the backend disposed its session because the signed-in identity
  // changed, so what this lifecycle holds is a dead session no reconcile can use. Staying `started`
  // would make Retry a no-op that reports success; unstarted, Retry reconnects — and fails loudly
  // while the backend is still signed into the wrong identity.
  function handleStatus(value: string): void {
    if (value === 'identity-changed' && !closed) {
      engine = undefined;
      session = undefined;
      started = false;
      input.onCoordinator?.(undefined);
      input.onSharing?.(undefined);
    }
    input.onStatus?.(value);
  }

  function abort(): void {
    if (closed) return;
    controller.abort();
    engine?.stop().catch(() => {});
  }

  async function start(): Promise<void> {
    if (started || closed) return;
    started = true;
    let connected: SyncSession | undefined = preconnected;
    preconnected = undefined;
    // An explicit connect must surface why it failed. Restoring a persisted binding must not: the
    // plugin can be missing or the options stale, and the documented retry calls start() again on
    // this same lifecycle. Nothing was connected yet, so stay unstarted or that retry no-ops and
    // the session stays offline until the whole server restarts.
    const giveUp = (message: string): void => {
      if (input.initialBinding !== undefined) throw new Error(message);
      started = false;
    };
    try {
      const binding = input.initialBinding ?? input.repo.readBinding();
      if (binding === null) return giveUp('Synchronization binding is missing');
      // A connect whose reviewed decisions never landed leaves its binding active but unfinished.
      // A restored lifecycle has no handover to wait for, so starting here would reconcile and
      // import the very objects the user never got to review. Only a fresh connect preview, which
      // re-reviews every row against the bound backend, clears the flag.
      if (input.initialBinding === undefined && binding.connectPending === true)
        return giveUp('Synchronization connect did not complete');
      bindingId = binding.id;
      bindingGeneration = binding.sessionGeneration;
      const backend = input.registry().resolveSync(binding.plugin, binding.capability);
      if (backend === undefined) return giveUp('Synchronization backend is unavailable');
      const configFile = input.configFile;
      if (configFile === undefined) return giveUp('Synchronization config is unavailable');
      const parsedOptions = backend.options.schema.safeParse(binding.options);
      if (!parsedOptions.success) return giveUp('Invalid synchronization backend options');
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
      // A candidate's binding is only written when the swap installs it, so the port's staleness
      // fence — which asks the repository which binding is live — rejects every read taken here.
      // There is nothing to recover either: the id is new, so it carries no prepared commit and no
      // confirmed baseline. The engine's first pass after activation runs this against the binding
      // once it is live, which is what seeds the baseline for a connect that published no commit.
      if (input.initialBinding === undefined) await recoverLocalCommits(input.repo, binding.id, port);
      connected ??= await backend.connect(parsedOptions.data, { signal: controller.signal, dataDirectory });
      const current = input.repo.readBinding();
      const currentBindingMismatch =
        input.initialBinding === undefined &&
        (current === null || current.id !== binding.id || current.sessionGeneration !== binding.sessionGeneration);
      const sessionMismatch = connected.identityId !== binding.identityId || connected.spaceId !== binding.spaceId;
      if (closed || currentBindingMismatch || sessionMismatch) {
        await connected.dispose().catch(() => {});
        connected = undefined;
        if (closed) return;
        // Nothing was connected, so a restored lifecycle stays retryable: the user can sign the
        // backend back into the bound identity and Retry, which calls start() on this same object.
        return giveUp('Synchronization session does not match binding');
      }
      session = connected;
      const store = createSyncObjectStore(connected);
      input.onCoordinator?.(createSharedOAuthCoordinator({ binding, store, repo: input.repo }));
      const sharing = createSharing(input, binding, store);
      input.onSharing?.(sharing);
      await sharing.recover(controller.signal);
      engine = createSyncEngine({
        binding,
        session,
        repo: input.repo,
        local: port,
        onStatus: handleStatus,
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
      // A routine backend outage must not abort server startup, taking model traffic and the
      // Dashboard recovery actions down with it.
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
    signal: controller.signal,
  };
}
