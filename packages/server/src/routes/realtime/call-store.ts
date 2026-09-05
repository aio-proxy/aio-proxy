import type { RealtimeStyle } from '@aio-proxy/plugin-sdk';

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

export type RealtimeCallStore = {
  readonly insert: (record: RealtimeCallRecord) => void;
  readonly lookup: (callId: string) => RealtimeCallRecord | undefined;
  readonly reserve: (callId: string) => RealtimeAttachment | undefined;
  readonly release: (token: number) => void;
  readonly attachment: (callId: string) => RealtimeAttachment | undefined;
  /** Runs a live attachment's teardown with `code` and clears the reservation.
   *  Returns false when there was nothing attached. */
  readonly closeAttachment: (callId: string, code: number) => boolean;
  readonly remove: (callId: string) => void;
  readonly hasCapacity: () => boolean;
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
  let nextToken = 1;
  let closed = false;

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
      if (closed) return;
      entries.set(record.callId, { record, attachment: undefined });
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
    remove(callId) {
      entries.delete(callId);
    },
    closeAttachment(callId, code) {
      const entry = live(callId);
      const held = entry?.attachment;
      if (entry === undefined || held === undefined) return false;
      entry.attachment = undefined;
      if (held.close !== undefined) {
        try {
          held.close(code);
        } catch {}
      }
      return true;
    },
    hasCapacity() {
      sweep();
      return entries.size < capacity;
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
            close(1001);
          } catch {}
        }
      }
      entries.clear();
    },
  };
}
