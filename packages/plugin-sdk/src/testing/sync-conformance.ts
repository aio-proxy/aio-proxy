import { SyncBackendError, type SyncSession } from '../sync';

export type SyncConformancePair = {
  readonly a: SyncSession;
  readonly b: SyncSession;
  readonly cleanup: () => Promise<void>;
  readonly faults?: { readonly outcomeUnknownOnce: (session: SyncSession) => void };
};

function assertion(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Sync backend conformance failed: ${message}`);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function exerciseSyncBackend(factory: () => Promise<SyncConformancePair>): Promise<void> {
  const pair = await factory();
  const prefix = `aio-proxy-conformance/${crypto.randomUUID()}/`;
  const key = `${prefix}value`;
  const signal = new AbortController().signal;
  const value = new TextEncoder().encode('value');
  const createdKeys = new Set<string>();

  let primaryError: unknown;
  try {
    createdKeys.add(key);
    const created = await Promise.all([
      pair.a.compareAndSwap(key, null, value, signal),
      pair.b.compareAndSwap(key, null, value, signal),
    ]);
    assertion(created.filter((result) => result.kind === 'written').length === 1, 'only one create succeeds');
    assertion(created.filter((result) => result.kind === 'conflict').length === 1, 'one competing create conflicts');

    const read = await pair.a.read(key, signal);
    assertion(read.kind === 'present', 'a created value can be read');
    assertion(sameBytes(read.value, value), 'read returns the written bytes');
    createdKeys.add(key);
    const stale = await pair.b.compareAndSwap(key, read.version, new TextEncoder().encode('replacement'), signal);
    assertion(stale.kind === 'written', 'current version writes');
    const staleAgain = await pair.a.compareAndSwap(key, read.version, value, signal);
    assertion(staleAgain.kind === 'conflict', 'stale version conflicts');

    if (pair.faults !== undefined) {
      const uncertainKey = `${prefix}outcome-unknown`;
      createdKeys.add(uncertainKey);
      pair.faults.outcomeUnknownOnce(pair.a);
      let uncertain = false;
      try {
        await pair.a.compareAndSwap(uncertainKey, null, value, signal);
      } catch (error) {
        uncertain = error instanceof SyncBackendError && error.code === 'outcome-unknown';
      }
      assertion(uncertain, 'unknown write outcomes are surfaced');
      const recovered = await pair.a.read(uncertainKey, signal);
      assertion(recovered.kind === 'present' && sameBytes(recovered.value, value), 'unknown writes are recoverable');
    }

    const listA = `${prefix}list-a`;
    const listKeys = [listA, `${prefix}list-b`];
    for (const listKey of listKeys) {
      createdKeys.add(listKey);
      const result = await pair.b.compareAndSwap(listKey, null, value, signal);
      assertion(result.kind === 'written', 'list fixture creates');
    }
    const discovered = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await pair.a.list({ prefix, ...(cursor === undefined ? {} : { cursor }) }, signal);
      for (const listedKey of page.keys) discovered.add(listedKey);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    for (const expectedKey of [key, ...listKeys]) assertion(discovered.has(expectedKey), 'pagination finds every key');

    const current = await pair.a.read(key, signal);
    assertion(current.kind === 'present', 'value exists before remove');
    const conflict = await pair.b.remove(key, read.version, signal);
    assertion(conflict.kind === 'conflict', 'stale remove conflicts');
    const removed = await pair.b.remove(key, current.version, signal);
    assertion(removed.kind === 'removed', 'current remove succeeds');
    assertion((await pair.a.read(key, signal)).kind === 'absent', 'removed key is absent');

    await pair.a.dispose();
    let disposedRejected = false;
    try {
      await pair.a.read(key, signal);
    } catch {
      disposedRejected = true;
    }
    assertion(disposedRejected, 'disposed session rejects new work');
    assertion((await pair.b.read(listA, signal)).kind === 'present', 'disposing one session preserves another');
  } catch (error) {
    primaryError = error;
  }
  const cleanupErrors: unknown[] = [];
  for (const cleanupKey of createdKeys) {
    let removed = false;
    let cleanupErrorRecorded = false;
    for (let attempt = 0; attempt < 2 && !removed; attempt += 1) {
      try {
        const current = await pair.b.read(cleanupKey, signal);
        if (current.kind === 'absent') removed = true;
        else {
          const result = await pair.b.remove(cleanupKey, current.version, signal);
          removed = result.kind === 'removed';
        }
      } catch (error) {
        if (attempt === 1) {
          cleanupErrors.push(error);
          cleanupErrorRecorded = true;
        }
      }
    }
    if (!removed && !cleanupErrorRecorded) cleanupErrors.push(new Error('sync fixture cleanup did not complete'));
  }
  try {
    await pair.cleanup();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    const cleanupError = new AggregateError(cleanupErrors, 'sync backend fixture cleanup failed');
    if (primaryError !== undefined) throw new AggregateError([primaryError, cleanupError], 'sync conformance failed');
    throw cleanupError;
  }
  if (primaryError !== undefined) throw primaryError;
}
