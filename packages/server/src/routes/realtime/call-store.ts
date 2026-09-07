import type { RealtimeStyle } from '@aio-proxy/plugin-sdk';

import { NORMAL_CLOSE_CODE, SHUTDOWN_CLOSE_CODE } from './close-code';

export const REALTIME_CALL_CAPACITY = 1024;
export const REALTIME_CALL_TTL_MS = 3_600_000;

/** Structurally satisfied by Task 6's `CallerPrincipal`. Typed loosely here so the
 *  store carries no dependency on the auth middleware. */
export type RealtimeCallOwner = { readonly kind: string; readonly id?: string };

export type RealtimeCallRecord = {
  readonly callId: string;
  readonly providerId: string;
  readonly accountId: string;
  readonly runtimeRevision: number;
  readonly model: string;
  readonly requestedModel: string;
  readonly style: RealtimeStyle;
  readonly owner: RealtimeCallOwner;
  readonly createdAt: number;
};

export type RealtimeAttachment = {
  readonly callId: string;
  readonly token: number;
  /** Registers the teardown the store runs on `closeAttachment()` and `close()`.
   *  It receives the close code so shutdown uses `1001` and a 2xx hangup `1000`. */
  readonly onClose: (close: (code: number) => void) => void;
};

/** Holds a capacity slot for a create that has not inserted its record yet.
 *  `release()` is idempotent: a double release must not manufacture capacity. */
export type RealtimeCapacitySlot = { readonly release: () => void };

/** Keeps a relay that owns no call record reachable from `close()`.
 *  `release()` is idempotent and must run on teardown: an unreleased hook is a retained
 *  closure per finished relay. */
export type RealtimeShutdownHook = { readonly release: () => void };

export type RealtimeCallStore = {
  /** `false` when the call ID is already held by a live record, or the store is closed —
   *  in both cases nothing was stored and the caller must not answer the create `201`.
   *  Never replaces: an overwrite would hand the first call's owner and provider pin to the
   *  second, and would orphan the first call's attachment, whose later teardown deletes by
   *  call ID and would therefore delete the *replacement's* record. */
  readonly insert: (record: RealtimeCallRecord) => boolean;
  readonly lookup: (callId: string) => RealtimeCallRecord | undefined;
  readonly reserve: (callId: string) => RealtimeAttachment | undefined;
  readonly release: (token: number) => void;
  readonly attachment: (callId: string) => RealtimeAttachment | undefined;
  /** Runs a live attachment's teardown with `code` and clears the reservation.
   *  Returns false when there was nothing attached.
   *  `expected` scopes the close to one record — see `remove`. */
  readonly closeAttachment: (callId: string, code: number, expected?: RealtimeCallRecord) => boolean;
  /** `expected` scopes the deletion to the record the caller observed. The hangup route
   *  awaits an upstream fetch between its `lookup` and this call, and a record with no
   *  attachment can expire in that window, letting a concurrent create claim the same call
   *  ID — an unscoped delete would then tear down that replacement, which belongs to another
   *  caller. Omit it only where the record cannot have been replaced. */
  readonly remove: (callId: string, expected?: RealtimeCallRecord) => void;
  /** Drops expired records, then claims a slot for one not-yet-inserted record.
   *  `undefined` means the store is full or already closed. A mere `hasCapacity()`
   *  predicate could not hold the bound: the create yields on the upstream fetch
   *  between the check and `insert`, so concurrent creates would all observe the
   *  same free slot. */
  readonly reserveCapacity: () => RealtimeCapacitySlot | undefined;
  /** Registers a teardown for a relay that owns no call record, so `close()` reaches it too.
   *  A direct `GET /v1/realtime` carries no `call_id` and therefore no attachment, and the
   *  store is the only resource the server's shutdown consults to close realtime sockets —
   *  without this hook, `server.stop(true)` force-terminated a live direct relay instead of
   *  closing it with the spec's `1001`. Returns `undefined` once the store is closed, in
   *  which case the caller must tear its own relay down: shutdown has already run. */
  readonly trackShutdown: (close: (code: number) => void) => RealtimeShutdownHook | undefined;
  readonly size: () => number;
  readonly close: () => void;
};

export function sameCallerPrincipal(left: RealtimeCallOwner, right: RealtimeCallOwner): boolean {
  return left.kind === right.kind && left.id === right.id;
}

type Entry = {
  readonly record: RealtimeCallRecord;
  attachment: { readonly token: number; close: ((code: number) => void) | undefined } | undefined;
};

export function createRealtimeCallStore(
  options: { readonly now?: () => number; readonly capacity?: number; readonly ttlMs?: number } = {},
): RealtimeCallStore {
  const now = options.now ?? Date.now;
  const capacity = options.capacity ?? REALTIME_CALL_CAPACITY;
  const ttlMs = options.ttlMs ?? REALTIME_CALL_TTL_MS;
  const entries = new Map<string, Entry>();
  /** Teardowns for relays that own no call record. Keyed by an opaque token rather than by
   *  call ID because a direct relay has none, and identity-keyed so two concurrent direct
   *  relays cannot displace each other. */
  const untracked = new Map<number, (code: number) => void>();
  let nextToken = 1;
  let closed = false;
  /** Slots claimed by creates whose record is not in `entries` yet. */
  let pending = 0;

  // A live attachment never expires: the call is in use, and dropping its routing
  // mid-session would 503 a working sideband.
  const expired = (entry: Entry): boolean => entry.attachment === undefined && now() - entry.record.createdAt > ttlMs;
  const sweep = (): void => {
    for (const [callId, entry] of entries) if (expired(entry)) entries.delete(callId);
  };
  const live = (callId: string): Entry | undefined => {
    const entry = entries.get(callId);
    if (entry === undefined) return undefined;
    if (!expired(entry)) return entry;
    entries.delete(callId);
    return undefined;
  };

  return {
    insert(record) {
      if (closed) return false;
      // `live()` rather than `entries.has()`: an expired record is not a collision, and
      // leaving it in place would make a call ID unusable for the rest of the process.
      if (live(record.callId) !== undefined) return false;
      entries.set(record.callId, { record, attachment: undefined });
      return true;
    },
    lookup(callId) {
      return live(callId)?.record;
    },
    reserve(callId) {
      const entry = live(callId);
      if (entry === undefined || entry.attachment !== undefined) return undefined;
      const token = nextToken;
      nextToken += 1;
      const attachment = { token, close: undefined as ((code: number) => void) | undefined };
      entry.attachment = attachment;
      return {
        callId,
        token,
        onClose(close) {
          // The sideband registers its teardown only once `dial()` resolves, up to
          // 10 s after the reservation. A shutdown or a 2xx hangup landing inside
          // that window has already cleared this reservation, so merely storing the
          // callback would leave the upstream socket with nothing to close it.
          if (entry.attachment !== attachment) {
            close(closed ? SHUTDOWN_CLOSE_CODE : NORMAL_CLOSE_CODE);
            return;
          }
          attachment.close = close;
        },
      };
    },
    // Token-scoped so a superseded socket's late `close` cannot free a newer
    // attachment: the store only clears the reservation it still holds.
    release(token) {
      for (const entry of entries.values()) {
        if (entry.attachment?.token === token) {
          entry.attachment = undefined;
          return;
        }
      }
    },
    attachment(callId) {
      const entry = live(callId);
      const held = entry?.attachment;
      if (entry === undefined || held === undefined) return undefined;
      return {
        callId,
        token: held.token,
        onClose(close) {
          held.close = close;
        },
      };
    },
    remove(callId, expected) {
      const entry = entries.get(callId);
      if (entry === undefined) return;
      if (expected !== undefined && entry.record !== expected) return;
      entries.delete(callId);
    },
    closeAttachment(callId, code, expected) {
      const entry = live(callId);
      const held = entry?.attachment;
      if (entry === undefined || held === undefined) return false;
      if (expected !== undefined && entry.record !== expected) return false;
      entry.attachment = undefined;
      if (held.close !== undefined) {
        try {
          held.close(code);
        } catch {}
      }
      return true;
    },
    reserveCapacity() {
      sweep();
      // Refused after `close()` because `insert` is a no-op from then on: a create that
      // still dialed would answer 201 with a Location no attach could ever resolve.
      if (closed || entries.size + pending >= capacity) return undefined;
      pending += 1;
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          pending -= 1;
        },
      };
    },
    trackShutdown(close) {
      if (closed) return undefined;
      const token = nextToken;
      nextToken += 1;
      untracked.set(token, close);
      return {
        release() {
          untracked.delete(token);
        },
      };
    },
    size() {
      sweep();
      return entries.size;
    },
    close() {
      if (closed) return;
      closed = true;
      for (const entry of entries.values()) {
        const close = entry.attachment?.close;
        entry.attachment = undefined;
        if (close !== undefined) {
          try {
            close(SHUTDOWN_CLOSE_CODE);
          } catch {}
        }
      }
      entries.clear();
      // Snapshotted before the loop: each teardown releases its own hook synchronously,
      // and clearing afterwards would drop a hook a concurrent relay registered mid-loop —
      // though `closed` is already true by then, so `trackShutdown` refuses it instead.
      const hooks = [...untracked.values()];
      untracked.clear();
      for (const close of hooks) {
        try {
          close(SHUTDOWN_CLOSE_CODE);
        } catch {}
      }
    },
  };
}
