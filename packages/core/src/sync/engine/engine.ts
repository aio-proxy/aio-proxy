import { SyncBackendError, type SyncSession } from '@aio-proxy/plugin-sdk';

import { collectHistory, deleteEntity, purgeEntity, readServerTime } from '../cleanup';
import { recoverLocalCommits } from '../local-commit';
import { decodeHead, entityKey, SyncProtocolError, type EntityHead } from '../protocol';
import { publishEntity, createSyncObjectStore, exceedsValueLimit } from '../publication';
import type { LocalBinding, OutboxOperation, SyncRepository } from '../repository';
import type { LocalSyncPort } from './incoming';
import { reconcileRemote } from './remote';
import { DEFAULT_POLL_MS, MAX_BACKOFF_MS, nextBackoffMs } from './scheduler';

export interface SyncEngine {
  reconcile(signal: AbortSignal): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

type EngineInput = {
  binding: LocalBinding;
  session: SyncSession;
  repo: SyncRepository;
  local: LocalSyncPort;
  onStatus(status: string): void;
  pollMs?: number;
};

class StaleSessionError extends Error {
  override readonly name = 'StaleSessionError';
}

function isBackendFailure(error: unknown): error is SyncBackendError {
  return error instanceof SyncBackendError;
}

// eslint-disable-next-line max-lines-per-function
export function createSyncEngine(input: EngineInput): SyncEngine {
  const pollMs = Math.max(1, input.pollMs ?? DEFAULT_POLL_MS);
  const ownedController = new AbortController();
  const store = createSyncObjectStore(input.session);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;
  let running: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let started = false;
  let stopped = false;
  let disposed = false;
  let backoff = 0;

  function status(value: string): void {
    try {
      input.onStatus(value);
    } catch {
      // Status reporting must not stop synchronization.
    }
  }

  function currentGeneration(): number {
    return input.repo.readBinding()?.sessionGeneration ?? input.binding.sessionGeneration;
  }

  function assertCurrent(): void {
    const binding = input.repo.readBinding();
    if (
      binding === null ||
      binding.id !== input.binding.id ||
      binding.sessionGeneration !== input.binding.sessionGeneration ||
      input.session.identityId !== input.binding.identityId ||
      input.session.spaceId !== input.binding.spaceId
    ) {
      throw new StaleSessionError('The synchronization session is no longer current');
    }
  }

  function assertGeneration(generation: number): void {
    if (currentGeneration() !== generation) throw new StaleSessionError('The synchronization session is stale');
    assertCurrent();
  }

  async function readHead(objectId: string, signal: AbortSignal): Promise<EntityHead | null> {
    const value = await input.session.read(entityKey(objectId), signal);
    if (value.kind === 'absent') return null;
    const head = decodeHead(value.value);
    if (head.objectId !== objectId) throw new SyncProtocolError('invalid-data', 'head object identity mismatch');
    return head;
  }

  /** Publishes one queued operation. Returns true when it stays queued and cannot be published. */
  async function publishOperation(
    operation: OutboxOperation,
    generation: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    assertGeneration(generation);
    // The object left the synchronized range after this was queued — while the backend was
    // unreachable, most likely. Publishing the queued body would upload configuration the user
    // moved back to local, and running the queued delete would remove the cloud copy that
    // leaving deliberately retains.
    const entity = input.repo.entities(input.binding.id).find((row) => row.objectId === operation.objectId);
    if (entity?.mode === 'excluded') {
      input.repo.acknowledge(input.binding.id, operation.operationId);
      return false;
    }
    // Supersession comes from the outbox as it stands, not from the pass's snapshot: a local commit
    // confirmed during an earlier operation's network wait appends to it. An entry a newer one
    // replaces carries a body nothing needs any more, which is what makes dropping an unpublishable
    // one safe, and a delete must not be published at all: the tombstone it leaves defeats that
    // newer put at the state check below, so an object deleted and re-added while the backend was
    // unreachable would be dropped again by the next remote reconciliation. The end state the
    // outbox describes is the newest operation's.
    const queued = input.repo.outbox(input.binding.id).filter((entry) => entry.objectId === operation.objectId);
    const newest = queued.at(-1)?.operationId === operation.operationId;
    if (operation.kind === 'delete' && !newest) {
      input.repo.acknowledge(input.binding.id, operation.operationId);
      return false;
    }
    // A body over the backend's value limit throws `quota` deterministically, and a failed entry
    // is never acknowledged, so retrying it first on every pass wedges every later object — and
    // remote reconciliation behind it — on a row that can never publish. A newer operation for
    // the same object supersedes it outright; the newest one stays queued, since shrinking the
    // configuration is what produces its replacement, and the pass reports `quota` instead of
    // `online` for as long as it is there.
    if (exceedsValueLimit(store, operation)) {
      if (!newest) input.repo.acknowledge(input.binding.id, operation.operationId);
      return newest;
    }
    const head = await store.readHead(operation.objectId, signal);
    assertGeneration(generation);
    // A newer epoch means another device deleted and restored this object while the operation sat
    // in the outbox. Publishing or deleting against the stale epoch can only throw
    // `epoch-mismatch`, and a failed entry is never acknowledged, so it would block every later
    // pass forever. The restore replaced what this operation was editing, so it is obsolete.
    const superseded = head !== null && head.head.epoch > operation.epoch;
    if (operation.kind === 'put' && operation.body !== null) {
      if (superseded || (head !== null && head.head.state !== 'active')) {
        // A tombstone exists to defeat stale edits: another device deleted this object while the
        // put was queued. Resurrecting it here would bypass the review a restore requires, so the
        // stale write is dropped and remote reconciliation applies the deletion locally. The
        // configuration is still recoverable through an explicit restore preview.
        input.repo.acknowledge(input.binding.id, operation.operationId);
        return false;
      }
      await publishEntity(store, operation, signal);
    } else {
      if (superseded || head === null || head.head.state === 'deleted' || head.head.state === 'purged') {
        input.repo.acknowledge(input.binding.id, operation.operationId);
        return false;
      }
      await deleteEntity(store, operation.objectId, operation.epoch, signal);
    }
    assertGeneration(generation);
    input.repo.acknowledge(input.binding.id, operation.operationId);
    return false;
  }

  async function drainOutbox(generation: number, signal: AbortSignal): Promise<boolean> {
    let unpublishable = false;
    for (const operation of input.repo.outbox(input.binding.id)) {
      signal.throwIfAborted();
      // Each publication holds the mutation fence, from its guards through the backend write:
      // leaving the synchronized range and a local commit's outbox append both run in that queue,
      // and either one landing mid-publication uploads a body the user moved back to local, deletes
      // a cloud copy leaving retains, or tombstones an object that has just been re-added. Nothing
      // may hold the fence while awaiting a drain — the queue is not reentrant, so a fenced caller
      // waiting on `stop()` or `reconcile()` would deadlock against this.
      unpublishable =
        (await input.local.withFence(() => publishOperation(operation, generation, signal))) || unpublishable;
    }
    return unpublishable;
  }

  async function maintenance(signal: AbortSignal): Promise<void> {
    const now = await readServerTime(store, signal);
    for (const entity of input.repo.entities(input.binding.id)) {
      let head: EntityHead | null;
      try {
        head = await readHead(entity.objectId, signal);
      } catch (error) {
        if (error instanceof SyncProtocolError) continue;
        throw error;
      }
      if (head === null) continue;
      if (head.state === 'purging') await purgeEntity(store, entity.objectId, signal);
      else await collectHistory(store, entity.objectId, now, signal);
    }
  }

  async function reconcileOnce(externalSignal: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([externalSignal, ownedController.signal]);
    assertCurrent();
    const generation = input.binding.sessionGeneration;
    await recoverLocalCommits(input.repo, input.binding.id, {
      ...input.local,
      assertCurrent: () => assertGeneration(generation),
      publishableQueued: (operation) => !exceedsValueLimit(store, operation),
    });
    assertGeneration(generation);
    const unpublishable = await drainOutbox(generation, signal);
    await reconcileRemote(
      {
        bindingId: input.binding.id,
        session: input.session,
        repo: input.repo,
        local: input.local,
        assertGeneration,
      },
      generation,
      signal,
    );
    assertGeneration(generation);
    await maintenance(signal);
    backoff = 0;
    status(unpublishable ? 'quota' : 'online');
  }

  function schedule(delay: number): void {
    if (stopped) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void coalescedReconcile(ownedController.signal)
        .catch(() => undefined)
        .finally(() => schedule(backoff || pollMs));
    }, delay);
  }

  function disposeSession(): Promise<void> {
    if (disposed) return Promise.resolve();
    disposed = true;
    return input.session.dispose().catch(() => undefined);
  }

  // Terminal: the session is gone and no schedule may resurrect it. Reported as
  // `identity-changed` rather than `stopped` so the caller can distinguish "needs reconnect" from
  // an ordinary shutdown.
  function stopForIdentityChange(): Promise<void> {
    if (stopPromise !== undefined) return stopPromise;
    stopped = true;
    ownedController.abort();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    unsubscribe?.();
    unsubscribe = undefined;
    stopPromise = disposeSession().then(() => status('identity-changed'));
    return stopPromise;
  }

  function coalescedReconcile(signal: AbortSignal): Promise<void> {
    if (stopped) return Promise.resolve();
    if (running !== undefined) return running;
    running = reconcileOnce(signal)
      .catch((error: unknown) => {
        if (error instanceof StaleSessionError || (error instanceof SyncBackendError && error.code === 'cancelled'))
          return;
        if (isBackendFailure(error) && (error.code === 'offline' || error.code === 'quota')) {
          backoff = Math.min(MAX_BACKOFF_MS, nextBackoffMs(backoff, pollMs));
          status(error.code);
          return;
        }
        // The backend disposed the session when the signed-in identity changed. Retrying against it
        // can only fail, so the engine stops and reports the state the user has to act on. The
        // failure still propagates: an explicit reconcile must not report success.
        if (isBackendFailure(error) && error.code === 'identity-changed') {
          void stopForIdentityChange();
          throw error;
        }
        status('error');
        throw error;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  }

  return {
    reconcile(signal) {
      return coalescedReconcile(signal);
    },
    start() {
      if (stopped || started) return;
      started = true;
      try {
        if (input.session.watch !== undefined) {
          unsubscribe = input.session.watch(() => {
            void coalescedReconcile(ownedController.signal).catch(() => undefined);
          });
        }
        schedule(pollMs);
      } catch (error) {
        stopped = true;
        ownedController.abort();
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        unsubscribe?.();
        unsubscribe = undefined;
        stopPromise = disposeSession().then(() => status('stopped'));
        throw error;
      }
    },
    stop() {
      if (stopPromise !== undefined) return stopPromise;
      stopped = true;
      ownedController.abort();
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      stopPromise = (running ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          await disposeSession();
          status('stopped');
        });
      return stopPromise;
    },
  };
}
