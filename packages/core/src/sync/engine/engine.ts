import { SyncBackendError, type SyncSession } from '@aio-proxy/plugin-sdk';

import { collectHistory, deleteEntity, purgeEntity, readServerTime, restoreEntity } from '../cleanup';
import { recoverLocalCommits } from '../local-commit';
import { decodeHead, entityKey, SyncProtocolError, type EntityHead } from '../protocol';
import { publishEntity, createSyncObjectStore } from '../publication';
import type { LocalBinding, SyncRepository } from '../repository';
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

function combineSignals(first: AbortSignal, second: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (first.aborted || second.aborted) controller.abort();
  first.addEventListener('abort', abort, { once: true });
  second.addEventListener('abort', abort, { once: true });
  return {
    signal: controller.signal,
    dispose() {
      first.removeEventListener('abort', abort);
      second.removeEventListener('abort', abort);
    },
  };
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
    return decodeHead(value.value);
  }

  async function drainOutbox(generation: number, signal: AbortSignal): Promise<void> {
    for (const operation of input.repo.outbox(input.binding.id)) {
      signal.throwIfAborted();
      assertGeneration(generation);
      if (operation.kind === 'put' && operation.body !== null) {
        const head = await store.readHead(operation.objectId, signal);
        assertGeneration(generation);
        if (head !== null && head.head.state !== 'active') {
          await restoreEntity(store, operation.objectId, operation.body, operation.operationId, signal);
        } else {
          await publishEntity(store, operation, signal);
        }
      } else {
        const head = await store.readHead(operation.objectId, signal);
        assertGeneration(generation);
        if (head === null || head.head.state === 'deleted' || head.head.state === 'purged') {
          input.repo.acknowledge(input.binding.id, operation.operationId);
          continue;
        }
        await deleteEntity(store, operation.objectId, operation.epoch, signal);
      }
      assertGeneration(generation);
      input.repo.acknowledge(input.binding.id, operation.operationId);
    }
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
    const combined = combineSignals(externalSignal, ownedController.signal);
    const signal = combined.signal;
    try {
      assertCurrent();
      const generation = input.binding.sessionGeneration;
      await recoverLocalCommits(input.repo, input.binding.id, {
        ...input.local,
        assertCurrent: () => assertGeneration(generation),
      });
      assertGeneration(generation);
      await drainOutbox(generation, signal);
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
      status('online');
    } finally {
      combined.dispose();
    }
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
