import type { ConfigSpec } from '../config';
import type { LocalizedText } from '../localized-text';

export type SyncVersion = string;
export type SyncRead =
  | { kind: 'absent' }
  | { kind: 'present'; value: Uint8Array; version: SyncVersion; modifiedAt: number };
export type SyncCAS = { kind: 'written'; version: SyncVersion; modifiedAt: number } | { kind: 'conflict' };
export type SyncFailureCode =
  | 'offline'
  | 'quota'
  | 'identity-changed'
  | 'cancelled'
  | 'unauthorized'
  | 'unsupported'
  | 'outcome-unknown'
  | 'invalid-data';

export class SyncBackendError extends Error {
  override readonly name = 'SyncBackendError';

  constructor(
    readonly code: SyncFailureCode,
    message: string,
  ) {
    super(message);
  }
}

export interface SyncSession {
  readonly identityId: string;
  readonly spaceId: string;
  readonly maxValueBytes: number;
  read(key: string, signal: AbortSignal): Promise<SyncRead>;
  compareAndSwap(key: string, expected: SyncVersion | null, value: Uint8Array, signal: AbortSignal): Promise<SyncCAS>;
  list(
    input: { prefix: string; cursor?: string },
    signal: AbortSignal,
  ): Promise<{ keys: readonly string[]; nextCursor?: string }>;
  remove(key: string, expected: SyncVersion, signal: AbortSignal): Promise<{ kind: 'removed' | 'conflict' }>;
  watch?(onHint: () => void): () => void;
  dispose(): Promise<void>;
}

export interface SyncBackendDefinition<Options> {
  readonly id: string;
  readonly displayName: LocalizedText;
  readonly options: ConfigSpec<Options>;
  connect(options: Options, context: { signal: AbortSignal; dataDirectory: string }): Promise<SyncSession>;
}
