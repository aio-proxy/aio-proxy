import type { SyncFailureCode, SyncSession } from '@aio-proxy/plugin-sdk';

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const FAILURE_CODES = new Set<SyncFailureCode>([
  'offline',
  'quota',
  'identity-changed',
  'cancelled',
  'unauthorized',
  'unsupported',
  'outcome-unknown',
  'invalid-data',
]);

export type NativeRequest = {
  readonly id: string;
  readonly op: 'connect' | 'read' | 'cas' | 'list' | 'remove' | 'cancel' | 'dispose';
  readonly input: Record<string, unknown>;
};

export type NativeReply =
  | { readonly id: string; readonly ok: true; readonly result: unknown }
  | { readonly id: string; readonly ok: false; readonly error: { readonly code: SyncFailureCode } }
  | { readonly event: 'identity-changed' | 'change-hint' };

export type NativeConnectResult = {
  readonly identityId: string;
  readonly spaceId: string;
  readonly maxValueBytes: number;
  readonly protocol: number;
  readonly version: string;
};

export function parseNativeReply(text: string): NativeReply {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('native reply is not valid JSON');
  }
  if (!value || typeof value !== 'object') throw new Error('native reply is not an object');
  const object = value as Record<string, unknown>;
  if (object.event === 'identity-changed' || object.event === 'change-hint') return { event: object.event };
  if (typeof object.id !== 'string' || typeof object.ok !== 'boolean') throw new Error('invalid native reply envelope');
  if (object.ok) return { id: object.id, ok: true, result: object.result };
  const error = object.error;
  if (!error || typeof error !== 'object' || typeof (error as Record<string, unknown>).code !== 'string') {
    throw new Error('invalid native error reply');
  }
  const code = (error as Record<string, unknown>).code;
  if (typeof code !== 'string' || !FAILURE_CODES.has(code as SyncFailureCode))
    throw new Error('invalid native error code');
  return { id: object.id, ok: false, error: { code: code as SyncFailureCode } };
}

export function assertConnectResult(result: unknown): NativeConnectResult {
  if (!result || typeof result !== 'object') throw new Error('invalid native connect result');
  const value = result as Record<string, unknown>;
  if (
    typeof value.identityId !== 'string' ||
    typeof value.spaceId !== 'string' ||
    typeof value.maxValueBytes !== 'number' ||
    value.protocol !== 1 ||
    typeof value.version !== 'string'
  ) {
    throw new Error('invalid native connect result');
  }
  return value as NativeConnectResult;
}

export class NativeSessionError extends Error {
  override readonly name = 'SyncBackendError';
  constructor(
    readonly code: SyncFailureCode,
    message: string = code,
  ) {
    super(message);
  }
}

export type { SyncSession };
