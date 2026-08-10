import { Buffer } from 'node:buffer';

import { LRUCache } from 'lru-cache';

export const CURSOR_SESSION_TTL_MS = 60 * 60_000;
export const CURSOR_SESSION_MAX_ENTRIES = 2048;
export const CURSOR_SESSION_MAX_BYTES = 64 * 1_024 * 1_024;

export type CursorSessionState = {
  readonly conversationId: string;
  readonly conversationState?: Uint8Array;
  readonly blobs: ReadonlyMap<string, Uint8Array>;
  readonly checkpointUsable: boolean;
  readonly expectedAffinity?: { readonly providerId: string; readonly revision: number };
  // Outer InteractionUpdate.callId -> nested McpArgs.toolCallId, so a resumed
  // AI-SDK result can restore Cursor's nested history ID.
  readonly pendingToolCalls: ReadonlyMap<string, string>;
};

export function sessionKey(input: { readonly identityScope: string; readonly logicalSessionKey: string }): string {
  return JSON.stringify([input.identityScope, input.logicalSessionKey]);
}

export class CursorSessionStore {
  readonly #cache: LRUCache<string, CursorSessionState>;

  constructor(options: { readonly max?: number; readonly maxSize?: number; readonly ttl?: number } = {}) {
    this.#cache = new LRUCache({
      max: options.max ?? CURSOR_SESSION_MAX_ENTRIES,
      maxSize: options.maxSize ?? CURSOR_SESSION_MAX_BYTES,
      sizeCalculation: cursorSessionSize,
      ttl: options.ttl ?? CURSOR_SESSION_TTL_MS,
      ttlAutopurge: true,
    });
  }

  get(key: string): CursorSessionState | undefined {
    return this.#cache.get(key);
  }

  set(key: string, state: CursorSessionState): void {
    this.#cache.set(key, state);
  }

  delete(key: string): void {
    this.#cache.delete(key);
  }
}

function cursorSessionSize(state: CursorSessionState, key: string): number {
  let size = Buffer.byteLength(key) + Buffer.byteLength(state.conversationId);
  size += state.conversationState?.byteLength ?? 0;
  for (const [blobKey, blob] of state.blobs) size += Buffer.byteLength(blobKey) + blob.byteLength;
  for (const [outerCallId, nestedCallId] of state.pendingToolCalls) {
    size += Buffer.byteLength(outerCallId) + Buffer.byteLength(nestedCallId);
  }
  if (state.expectedAffinity !== undefined) size += Buffer.byteLength(state.expectedAffinity.providerId) + 8;
  return Math.max(1, size);
}
