import { type CredentialPort, CredentialRefreshError, type RuntimeFetch } from '@aio-proxy/plugin-sdk';

import { cursorTokenExpiry } from '../jwt/index';
import type { CursorCredential } from '../schema';
import { CURSOR_REFRESH_URL } from './constants';

export type CursorOAuthDependencies = {
  readonly fetch?: RuntimeFetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly uuid?: () => string;
  readonly signal?: AbortSignal;
};

const isRetryableStatus = (status: number) => status === 408 || status === 429 || status >= 500;

export async function refreshCursorCredential(
  current: CursorCredential,
  options: CursorOAuthDependencies = {},
): Promise<CursorCredential> {
  const fetcher: RuntimeFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let response: Response;
  try {
    response = await fetcher(CURSOR_REFRESH_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${current.refreshToken}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: options.signal ?? null,
      aioProxy: { traffic: 'control' },
    });
  } catch {
    if (options.signal?.aborted) throw options.signal.reason;
    throw refreshError(true, 'network');
  }
  if (!response.ok) {
    const oauthError = await readOAuthError(response);
    const invalidGrant = oauthError === 'invalid_grant';
    throw refreshError(
      !invalidGrant && isRetryableStatus(response.status),
      invalidGrant ? 'invalid_grant' : response.status === 401 || response.status === 403 ? 'rejected' : 'http',
      response.status,
    );
  }
  const token = await parseToken(response);
  return {
    ...current,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? current.refreshToken,
    expiresAt: cursorTokenExpiry(token.accessToken, now()),
  };
}

export async function currentCursorCredential(
  port: CredentialPort<CursorCredential>,
  options: CursorOAuthDependencies = {},
): Promise<CursorCredential> {
  options.signal?.throwIfAborted();
  const current = await waitForCaller(port.read(), options.signal);
  options.signal?.throwIfAborted();
  if (current.value.expiresAt > (options.now ?? Date.now)()) return current.value;
  const refreshing = port.refresh(current.revision, async ({ value }, signal) => {
    const refreshed = await refreshCursorCredential(value, { ...options, signal });
    return {
      value: refreshed,
      metadata: { accountLabel: 'Cursor', expiresAt: refreshed.expiresAt },
    };
  });
  return (await waitForCaller(refreshing, options.signal)).snapshot.value;
}

async function parseToken(
  response: Response,
): Promise<{ readonly accessToken: string; readonly refreshToken?: string }> {
  let value: unknown;
  try {
    value = await response.json();
  } catch (error) {
    throw error instanceof SyntaxError ? refreshError(false, 'invalid') : refreshError(true, 'network');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw refreshError(false, 'invalid');
  const record = value as Record<string, unknown>;
  const accessToken = optionalString(record, 'accessToken');
  const refreshToken = optionalString(record, 'refreshToken');
  if (accessToken === undefined) throw refreshError(false, 'invalid');
  return { accessToken, ...(refreshToken === undefined ? {} : { refreshToken }) };
}

async function readOAuthError(response: Response): Promise<string | undefined> {
  try {
    const value: unknown = await response.json();
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? optionalString(value as Record<string, unknown>, 'error')
      : undefined;
  } catch {
    return undefined;
  }
}

function refreshError(retryable: boolean, reason: string, status?: number): CredentialRefreshError {
  return new CredentialRefreshError('Cursor credential refresh failed', {
    retryable,
    reason,
    ...(status === undefined ? {} : { status }),
  });
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === 'string' && field !== '' ? field : undefined;
}

async function waitForCaller<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return await operation;
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
