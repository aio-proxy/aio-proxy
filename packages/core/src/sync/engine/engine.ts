import { SyncBackendError, type SyncSession } from '@aio-proxy/plugin-sdk';

import { collectHistory, deleteEntity, purgeEntity, readServerTime, restoreEntity } from '../cleanup';
import { recoverLocalCommits, type LocalCommitPort } from '../local-commit';
import {
  decodeHead,
  decodeRevision,
  entityKey,
  revisionKey,
  SyncProtocolError,
  type EntityBody,
  type EntityHead,
  type RevisionRecord,
} from '../protocol';
import { publishEntity, createSyncObjectStore } from '../publication';
import type { LocalBinding, LocalEntity, SyncRepository } from '../repository';
import type { LocalSyncPort, PendingReason } from './incoming';
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

function operationForHead(head: EntityHead): string | undefined {
  return head.current ?? undefined;
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

function pendingFromError(error: unknown): PendingReason | undefined {
  if (error instanceof SyncProtocolError && error.code === 'upgrade-required') return 'upgrade-required';
  if (error instanceof SyncProtocolError && error.code === 'invalid-data') return 'invalid-config';
  return undefined;
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

  async function readCurrent(head: EntityHead, signal: AbortSignal): Promise<RevisionRecord | null> {
    const operationId = operationForHead(head);
    if (operationId === undefined) return null;
    const value = await input.session.read(revisionKey(head.objectId, operationId), signal);
    if (value.kind === 'absent') throw new SyncProtocolError('invalid-data', 'current revision is missing');
    const record = decodeRevision(value.value);
    if (
      record.protocol !== 1 ||
      record.objectId !== head.objectId ||
      record.operationId !== operationId ||
      record.epoch !== head.epoch ||
      record.state !== 'payload'
    ) {
      throw new SyncProtocolError('invalid-data', 'current revision identity mismatch');
    }
    if (record.body.kind !== head.kind || record.body.logicalKey !== head.logicalKey) {
      throw new SyncProtocolError('invalid-data', 'current revision logical identity mismatch');
    }
    return record;
  }

  function upsertEntity(
    bindingId: string,
    existing: LocalEntity | undefined,
    head: EntityHead,
    body: EntityBody | null,
    mode: LocalEntity['mode'],
    pendingReason: string | null,
    baseline: string | null,
  ): void {
    input.repo.putEntity(bindingId, {
      objectId: head.objectId,
      logicalKey: head.logicalKey,
      kind: head.kind,
      mode,
      epoch: head.epoch,
      desired: body,
      baseline,
      overrides: existing?.overrides ?? [],
      pendingReason,
    });
  }

  // eslint-disable-next-line max-lines-per-function
  async function reconcileRemote(generation: number, signal: AbortSignal): Promise<void> {
    const bindingId = input.binding.id;
    const conflictObjects = new Set<string>();
    const identities = new Map<string, Set<string>>();
    let discoveryCursor: string | undefined;
    do {
      const page = await input.session.list(
        { prefix: 's/v1/default/entity/', ...(discoveryCursor === undefined ? {} : { cursor: discoveryCursor }) },
        signal,
      );
      for (const key of page.keys) {
        const objectId = key.slice('s/v1/default/entity/'.length);
        if (objectId.length === 0) continue;
        const value = await input.session.read(entityKey(objectId), signal);
        if (value.kind === 'absent') continue;
        try {
          const head = decodeHead(value.value);
          if (head.state === 'active' && head.current !== null) {
            const identity = `${head.kind}\0${head.logicalKey}`;
            const members = identities.get(identity) ?? new Set<string>();
            members.add(objectId);
            identities.set(identity, members);
          }
        } catch {
          // The main pass preserves malformed/unknown records as read-only.
        }
      }
      discoveryCursor = page.nextCursor;
    } while (discoveryCursor !== undefined);
    for (const members of identities.values()) {
      if (members.size > 1) for (const objectId of members) conflictObjects.add(objectId);
    }
    let cursor: string | undefined;
    const known = new Map(input.repo.entities(bindingId).map((entity) => [entity.objectId, entity]));
    do {
      const page = await input.session.list(
        { prefix: 's/v1/default/entity/', ...(cursor === undefined ? {} : { cursor }) },
        signal,
      );
      for (const key of page.keys) {
        signal.throwIfAborted();
        const objectId = key.slice('s/v1/default/entity/'.length);
        if (objectId.length === 0) continue;
        let head: EntityHead;
        try {
          const value = await input.session.read(entityKey(objectId), signal);
          if (value.kind === 'absent') continue;
          head = decodeHead(value.value);
        } catch (error) {
          if (error instanceof SyncBackendError) throw error;
          const existing = known.get(objectId);
          if (existing !== undefined) {
            assertGeneration(generation);
            upsertEntity(
              bindingId,
              existing,
              {
                protocol: 1,
                objectId,
                kind: existing.kind,
                logicalKey: existing.logicalKey,
                epoch: existing.epoch,
                sequence: 0,
                state: 'active',
                current: null,
                history: [],
                reserved: [],
                cancelling: [],
                receipts: {},
                cleanupComplete: true,
              },
              existing.desired,
              existing.mode,
              pendingFromError(error) ?? 'upgrade-required',
              existing.baseline,
            );
          }
          continue;
        }
        const existing = known.get(objectId);
        const conflicting = [...known.values()].find(
          (candidate) =>
            candidate.objectId !== objectId && candidate.kind === head.kind && candidate.logicalKey === head.logicalKey,
        );
        if (head.state !== 'active') {
          if (existing !== undefined) {
            assertGeneration(generation);
            await input.local.applyRemote(objectId, null, `deleted:${head.epoch}`);
            assertGeneration(generation);
          }
          assertGeneration(generation);
          upsertEntity(bindingId, existing, head, null, existing?.mode ?? 'excluded', null, `deleted:${head.epoch}`);
          known.set(objectId, {
            ...existing,
            objectId,
            logicalKey: head.logicalKey,
            kind: head.kind,
            mode: existing?.mode ?? 'excluded',
            epoch: head.epoch,
            desired: null,
            baseline: `deleted:${head.epoch}`,
            overrides: existing?.overrides ?? [],
            pendingReason: null,
          });
          continue;
        }
        if (head.current === null) continue;
        let record: RevisionRecord | null;
        try {
          record = await readCurrent(head, signal);
        } catch (error) {
          if (error instanceof SyncBackendError) throw error;
          const reason = pendingFromError(error);
          if (existing !== undefined && reason !== undefined) {
            assertGeneration(generation);
            upsertEntity(bindingId, existing, head, existing.desired, existing.mode, reason, existing.baseline);
          }
          continue;
        }
        if (record === null || record.state !== 'payload') continue;
        const body = record.body;
        if (conflictObjects.has(objectId) || conflicting !== undefined) {
          const candidates = [...known.values(), ...(existing === undefined ? [] : [existing])].filter(
            (candidate, index, all) =>
              candidate.kind === head.kind &&
              candidate.logicalKey === head.logicalKey &&
              all.findIndex((item) => item.objectId === candidate.objectId) === index,
          );
          for (const candidate of candidates) {
            if (candidate.mode === 'included') {
              assertGeneration(generation);
              await input.local.applyRemote(candidate.objectId, null, `conflict:${head.epoch}`);
              assertGeneration(generation);
            }
            assertGeneration(generation);
            input.repo.putEntity(bindingId, {
              ...candidate,
              mode: 'excluded',
              pendingReason: 'provider-id-conflict',
            });
            known.set(candidate.objectId, { ...candidate, mode: 'excluded', pendingReason: 'provider-id-conflict' });
          }
          assertGeneration(generation);
          upsertEntity(bindingId, existing, head, body, 'excluded', 'provider-id-conflict', existing?.baseline ?? null);
          known.set(objectId, {
            ...existing,
            objectId,
            logicalKey: head.logicalKey,
            kind: head.kind,
            mode: 'excluded',
            epoch: head.epoch,
            desired: body,
            baseline: existing?.baseline ?? null,
            overrides: existing?.overrides ?? [],
            pendingReason: 'provider-id-conflict',
          });
          continue;
        }
        const mode = existing?.mode ?? 'included';
        if (mode === 'excluded') {
          assertGeneration(generation);
          upsertEntity(bindingId, existing, head, body, mode, null, record.operationId);
          known.set(objectId, {
            ...existing,
            objectId,
            logicalKey: head.logicalKey,
            kind: head.kind,
            mode,
            epoch: head.epoch,
            desired: body,
            baseline: record.operationId,
            overrides: existing?.overrides ?? [],
            pendingReason: null,
          });
          continue;
        }
        if (existing?.baseline === record.operationId && existing.pendingReason === null) continue;
        let activation;
        try {
          assertGeneration(generation);
          activation = await input.local.applyRemote(objectId, body, record.operationId);
          assertGeneration(generation);
        } catch (error) {
          const reason = pendingFromError(error);
          if (reason === undefined) throw error;
          assertGeneration(generation);
          activation = { applied: false, pending: reason };
        }
        const pending = activation.applied ? null : (activation.pending ?? 'invalid-config');
        upsertEntity(
          bindingId,
          existing,
          head,
          body,
          mode,
          pending,
          activation.applied ? record.operationId : (existing?.baseline ?? null),
        );
        known.set(objectId, {
          ...existing,
          objectId,
          logicalKey: head.logicalKey,
          kind: head.kind,
          mode,
          epoch: head.epoch,
          desired: body,
          baseline: activation.applied ? record.operationId : (existing?.baseline ?? null),
          overrides: existing?.overrides ?? [],
          pendingReason: pending,
        });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
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
      await recoverLocalCommits(input.repo, input.binding.id, input.local as LocalCommitPort);
      assertGeneration(generation);
      await drainOutbox(generation, signal);
      await reconcileRemote(generation, signal);
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
      if (input.session.watch !== undefined) {
        unsubscribe = input.session.watch(() => {
          void coalescedReconcile(ownedController.signal).catch(() => undefined);
        });
      }
      schedule(pollMs);
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
          if (disposed) return;
          disposed = true;
          await input.session.dispose().catch(() => undefined);
          status('stopped');
        });
      return stopPromise;
    },
  };
}
