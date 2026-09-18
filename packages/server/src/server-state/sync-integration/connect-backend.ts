import { chmod, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  seedAuthoredEntities,
  type AtomicConfigFile,
  type PluginRegistrySnapshot,
  type JsonValue,
  type LocalBinding,
  type SyncRepository,
} from '@aio-proxy/core';
import type { SyncSession } from '@aio-proxy/plugin-sdk';

import { createFifoQueue, type FifoQueue } from '../../fifo-queue';
import {
  assertNoRetainedOAuth,
  listRemoteEntities,
  SyncOperationError,
  type createLocalSyncPort,
  type createServerSyncLifecycle,
  type SyncConnectCandidate,
} from '../../sync-control-plane';
import type { ServerRuntime } from '../lifecycle';

/** Cloud artifact provisioning is minutes, not seconds; anything past this is a stalled backend. */
const CONNECT_STARTUP_TIMEOUT_MS = 5 * 60_000;

/** The pre-Apply re-read only lists what the preview already listed, and a user is waiting on it. */
const CONNECT_REFRESH_TIMEOUT_MS = 60_000;

const backendDataDirectory = (configPath: string, bindingId: string): string =>
  join(dirname(configPath), '.sync', bindingId);

/**
 * Backend state lives under `.sync/<binding-id>` — for CloudKit an extracted helper build and the
 * credentials it cached — and nothing revisits a binding id once it is retired. A swap removes the
 * binding it replaces, but a disconnect clears the row without touching the disk, and a process
 * killed mid-connect leaves its candidate's directory. A start is the one moment no candidate is in
 * flight, so every id that is not the bound one can be swept here.
 */
export async function pruneBackendData(configPath: string, keep: string | undefined): Promise<void> {
  const root = join(dirname(configPath), '.sync');
  for (const name of await readdir(root).catch(() => [])) {
    if (name !== keep) await rm(join(root, name), { recursive: true, force: true }).catch(() => {});
  }
}

/** The live pair a swap installs into. Owned by the integration, which reads it through getters. */
export interface SyncLifecycleSlot {
  port: ReturnType<typeof createLocalSyncPort> | undefined;
  lifecycle: ReturnType<typeof createServerSyncLifecycle> | undefined;
}

export interface CandidateLifecycle {
  readonly port: ReturnType<typeof createLocalSyncPort> | undefined;
  readonly lifecycle: ReturnType<typeof createServerSyncLifecycle>;
  publish(): void;
}

export interface ConnectBackendInput {
  readonly runtime: ServerRuntime;
  readonly configFile: AtomicConfigFile;
  readonly configPath: string;
  readonly syncRepository: SyncRepository;
  readonly plugins: () => PluginRegistrySnapshot;
  /** The mutation queue: the swap takes it so no local commit can land inside the handover. */
  readonly queue: FifoQueue;
  readonly active: SyncLifecycleSlot;
  readonly createLifecycle: (
    binding: LocalBinding,
    preconnectedSession: SyncSession,
    candidate: true,
  ) => CandidateLifecycle;
  /** Commit hooks capture the binding they were built for, so a swap has to rebuild them. */
  readonly refreshCommitHooks: () => void;
}

/**
 * Connecting a backend runs against a candidate the user has not committed to yet: it provisions,
 * lists the cloud state the preview reviews, and only swaps that candidate in once the reviewed
 * decisions are applied. The swap is transactional — it either installs the new lifecycle or leaves
 * the previous one untouched.
 */
export function createConnectBackend(input: ConnectBackendInput) {
  const { runtime, configFile, configPath, syncRepository, plugins, queue, active, createLifecycle } = input;
  const { refreshCommitHooks } = input;

  const replaceBackend = async (
    binding: LocalBinding,
    preconnectedSession: SyncSession,
    candidateRemote: SyncConnectCandidate['remote'],
    onHandoff: (handoff: CandidateLifecycle) => void,
  ): Promise<() => void> => {
    let next: ReturnType<typeof createLifecycle> | undefined;
    let retired: SyncLifecycleSlot['lifecycle'];
    let retiredId: string | undefined;
    try {
      next = createLifecycle(binding, preconnectedSession, true);
      onHandoff(next);
      await next.lifecycle.start();
      const authored = (await configFile.read()) as Record<string, JsonValue>;
      await queue(async () => {
        // Teardown reads `runtime.sync` once and closes what it finds there, so a swap that installs
        // after that read leaves a live lifecycle — for CloudKit a native helper — with nothing left
        // to close it. The install below runs synchronously with this check, so refusing here is
        // enough: shutdown either closes the new lifecycle or never sees it.
        if (runtime.closed) throw new SyncOperationError('backend-unavailable');
        const previousBinding = syncRepository.readBinding();
        // Retiring a binding that still holds a shared OAuth credential strands it: ownership names
        // an account object in the old backend's space, so detaching can no longer target it, and
        // the Provider stays blocked on this and every later binding. Refuse before anything is
        // committed and let the user detach on the backend that owns the credential.
        if (previousBinding !== null) assertNoRetainedOAuth(syncRepository, previousBinding.id);
        // Ownership is scoped to the space that holds the account object, and the replacement backend
        // has none. Nothing survives the guard above except an already detached row, so carry the
        // configuration only and let the new binding establish its own ownership.
        // Epoch and baseline name a head in the space being left, so they are rebased onto whatever
        // the candidate actually holds for that object: publishing with a carried epoch the new
        // space never issued fails `epoch-mismatch`, and a carried baseline would mark a remote
        // revision applied that this binding has never seen.
        const candidateEpochs = new Map(candidateRemote.map((entity) => [entity.objectId, entity.epoch ?? 0]));
        const previousEntities = (previousBinding === null ? [] : syncRepository.entities(previousBinding.id)).map(
          ({ oauth, ...entity }) => ({
            ...entity,
            epoch: candidateEpochs.get(entity.objectId) ?? 0,
            baseline: null,
            ...(oauth === undefined ? {} : { pendingReason: null }),
          }),
        );
        const previousLifecycle = active.lifecycle;
        const previousPort = active.port;
        const previousRuntimeSync = runtime.sync;
        try {
          syncRepository.writeBinding(binding);
          if (syncRepository.putEntities !== undefined) syncRepository.putEntities(binding.id, previousEntities);
          else for (const entity of previousEntities) syncRepository.putEntity(binding.id, entity);
          // Carrying the previous binding's rows over covers a backend switch, but a first
          // connection has none. Without a row per authored object the new binding starts blind:
          // status lists no Provider and a join has nothing to select. Seeding is excluded-only,
          // so connecting still publishes nothing until the user joins. An identity the candidate
          // already holds is left out: the reviewed decision for that row imports it under the
          // cloud object's own ID, and a seeded twin would collide with it. A row whose decision is
          // declined never gets written here, so the reviewed Apply seeds again for those.
          seedAuthoredEntities(
            syncRepository,
            binding.id,
            authored,
            candidateRemote.filter((entity) => entity.body !== null || (entity.restoreBody ?? null) !== null),
          );
          active.port = next!.port;
          active.lifecycle = next!.lifecycle;
          runtime.sync = active.lifecycle;
          next!.publish();
          retired = previousLifecycle;
          retiredId = previousBinding?.id;
        } catch (error) {
          active.port = previousPort;
          active.lifecycle = previousLifecycle;
          runtime.sync = previousRuntimeSync;
          if (syncRepository.readBinding()?.id === binding.id) {
            if (previousBinding === null) syncRepository.clearBinding?.();
            else syncRepository.writeBinding(previousBinding);
          }
          await next!.lifecycle.close().catch(() => {});
          throw error;
        }
      });
      // Closed outside the fence the swap held: the retired engine takes that same fence for each
      // publication and `close()` waits for a drain in flight, so closing from inside the slot would
      // deadlock against it. The swap already made every generation check in that engine stale, so
      // all it can do is unwind.
      await retired?.close().catch(() => {});
      // Only once that close returned: the retired backend still held this directory open, and it is
      // the last reference to it — every later read resolves the new binding id.
      if (retiredId !== undefined)
        await rm(backendDataDirectory(configPath, retiredId), { recursive: true, force: true }).catch(() => {});
      // The engine stays deferred until the caller has applied the reviewed connect decisions:
      // reconciling first would import the candidate's remote objects under the engine's default
      // inclusion, transiently activating a cloud configuration the user chose to overwrite.
      const activate = next.lifecycle.activate;
      return activate;
    } catch (error) {
      if (next === undefined) await preconnectedSession.dispose().catch(() => {});
      else await next.lifecycle.close().catch(() => {});
      throw error;
    }
  };

  // Candidate startup uses the mutation queue for local recovery, so serialize whole connect operations here and
  // keep the existing queue available for the recovery and transactional swap steps.
  const connectQueue = createFifoQueue();
  const connectBackend = (input: {
    plugin: string;
    capability: string;
    options: JsonValue;
  }): Promise<SyncConnectCandidate> =>
    connectQueue(async () => {
      const backend = plugins().registry.resolveSync(input.plugin, input.capability);
      const parsed = backend?.options.schema.safeParse(input.options);
      if (backend === undefined || parsed === undefined || !parsed.success)
        throw new SyncOperationError('backend-unavailable');
      const normalizedOptions = parsed.data as JsonValue;
      const bindingId = `sync-${crypto.randomUUID()}`;
      const dataDirectory = backendDataDirectory(configPath, bindingId);
      await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
      await chmod(dataDirectory, 0o700);
      // The candidate owns its backend work until `commit()` hands the session to a lifecycle: a
      // stalled `connect`/`list` would otherwise sit in `connectQueue` forever and block every later
      // connection attempt, and the per-attempt directory would pile up once the preview is dropped.
      const lifetime = new AbortController();
      const discard = async (): Promise<void> => {
        lifetime.abort();
        await rm(dataDirectory, { recursive: true, force: true }).catch(() => {});
      };
      // `discard()` is only reachable once these two awaits settle, so an unresponsive backend would
      // hold `connectQueue` for the life of the service and every later connection attempt with it.
      // Generous, because a first connect legitimately provisions cloud artifacts — but finite, so a
      // stall ends as a failed attempt.
      const startup = AbortSignal.any([lifetime.signal, AbortSignal.timeout(CONNECT_STARTUP_TIMEOUT_MS)]);
      let session: SyncSession | undefined;
      try {
        session = await backend.connect(normalizedOptions, { signal: startup, dataDirectory });
        if (session.spaceId !== 'default') throw new SyncOperationError('backend-unavailable');
        const current = syncRepository.readBinding();
        const candidateSession = session;
        // Read the candidate's cloud state before it is bound: this is the snapshot the preview
        // reviews, and reconciliation must not be the first thing that sees these objects.
        const remote = await listRemoteEntities(candidateSession, startup);
        session = undefined;
        const binding: LocalBinding = {
          id: bindingId,
          plugin: input.plugin,
          capability: input.capability,
          pluginVersion: plugins().plugins.get(input.plugin)?.version ?? 'unknown',
          identityId: candidateSession.identityId,
          spaceId: 'default',
          deviceId: current?.deviceId ?? crypto.randomUUID(),
          sessionGeneration: (current?.sessionGeneration ?? 0) + 1,
          options: normalizedOptions,
        };
        let released = false;
        let activateBackend: (() => void) | undefined;
        // The lifecycle a handover is currently starting, so teardown can end it from outside the
        // queue. Cleared the moment the swap settles: past that point it is either live or closed.
        let handoff: CandidateLifecycle | undefined;
        return {
          remote,
          // Apply awaits this re-read while holding the control plane's serialized queue, and the
          // candidate has already been taken out of the preview store by then, so an unbounded stall
          // would block Leave, Retry and Disconnect indefinitely. A re-list of state this candidate
          // already listed once needs far less room than provisioning did.
          refresh: () =>
            listRemoteEntities(
              candidateSession,
              AbortSignal.any([lifetime.signal, AbortSignal.timeout(CONNECT_REFRESH_TIMEOUT_MS)]),
            ),
          commit: () =>
            connectQueue(async () => {
              // replaceBackend takes over the session either way: on success the new lifecycle owns
              // it, and on failure it disposes the session or closes the lifecycle holding it. The
              // caller still disposes the candidate when applying fails, which would otherwise
              // either double-dispose or tear down the session that is now live.
              released = true;
              try {
                activateBackend = await replaceBackend(binding, candidateSession, remote, (value) => {
                  handoff = value;
                });
                refreshCommitHooks();
              } catch (error) {
                await discard();
                if (error instanceof SyncOperationError) throw error;
                throw new SyncOperationError('backend-unavailable');
              } finally {
                handoff = undefined;
              }
            }),
          activate: () => activateBackend?.(),
          // Serialized against `commit()`, which sets `released` before its swap begins: an
          // unqueued disposal would return while that handover was still in flight and let teardown
          // finish around it. Queued, it waits for the swap to install or unwind.
          dispose: () => {
            // The swap waits on the new lifecycle's `start()`, which can sit on the backend — an
            // OAuth recovery — with no bound of its own, and `commit()` holds the queue while it
            // does. Aborting from inside the queue would never be reached, so end the handover here
            // and let the queued body run once it has unwound.
            handoff?.lifecycle.abort();
            return connectQueue(async () => {
              if (released) return;
              released = true;
              await candidateSession.dispose().catch(() => {});
              await discard();
            });
          },
        };
      } catch (error) {
        await session?.dispose().catch(() => {});
        await discard();
        if (error instanceof SyncOperationError) throw error;
        throw new SyncOperationError('backend-unavailable');
      }
    });

  return connectBackend;
}
