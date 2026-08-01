import { LRUCache } from 'lru-cache';

export const CURSOR_SESSION_TTL_MS = 60 * 60_000;
export const CURSOR_SESSION_MAX_ENTRIES = 2048;

export type CursorSessionState = {
  readonly conversationId: string;
  readonly conversationState?: Uint8Array;
  readonly blobs: ReadonlyMap<string, Uint8Array>;
  readonly checkpointUsable: boolean;
  // callId -> toolCallId, so a resumed turn can map real Cursor tool results
  // back onto the AI-SDK tool calls that requested them.
  readonly pendingToolCalls: ReadonlyMap<string, string>;
};

export function sessionKey(input: { readonly identityScope: string; readonly logicalSessionKey: string }): string {
  return JSON.stringify([input.identityScope, input.logicalSessionKey]);
}

export class CursorSessionStore {
  readonly #cache: LRUCache<string, CursorSessionState>;

  constructor(options: { readonly max?: number; readonly ttl?: number } = {}) {
    this.#cache = new LRUCache({
      max: options.max ?? CURSOR_SESSION_MAX_ENTRIES,
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
