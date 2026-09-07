import { type CredentialPort, CredentialRefreshError, type RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import type { ClaudeCredential } from '../schema';
import { CLAUDE_CLIENT_ID, CLAUDE_OAUTH_BETA, CLAUDE_REFRESH_USER_AGENT, CLAUDE_TOKEN_URL } from './constants';
import { type ClaudeIdentity, resolveClaudeIdentity } from './identity';
import type { ClaudeOAuthOptions } from './types';

export async function refreshClaudeCredential(
  current: ClaudeCredential,
  options: ClaudeOAuthOptions = {},
): Promise<ClaudeCredential> {
  const fetcher: RuntimeFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let response: Response;
  try {
    response = await fetcher(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'anthropic-beta': CLAUDE_OAUTH_BETA,
        'user-agent': CLAUDE_REFRESH_USER_AGENT,
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CLAUDE_CLIENT_ID,
        refresh_token: current.refreshToken,
      }),
      aioProxy: { traffic: 'control' },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw refreshError(true, 'network');
  }
  if (!response.ok) throw await classifyFailedResponse(response);
  const token = await parseSuccessfulToken(response);
  const identity = await resolveRefreshIdentity(current, token.raw, fetcher, options.signal);
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? current.refreshToken,
    expiresAt: now() + token.expiresIn * 1000 - 5 * 60_000,
    ...optionalField('email', current.email ?? identity.email),
    ...optionalField('accountId', current.accountId ?? identity.accountId),
    ...optionalField('organizationId', current.organizationId),
    ...optionalField('organizationName', current.organizationName),
  };
}

export async function currentClaudeCredential(
  port: CredentialPort<ClaudeCredential>,
  options: ClaudeOAuthOptions = {},
): Promise<ClaudeCredential> {
  options.signal?.throwIfAborted();
  const current = await waitForCaller(port.read(), options.signal);
  options.signal?.throwIfAborted();
  if (current.value.expiresAt > (options.now ?? Date.now)()) return current.value;
  const refreshing = port.refresh(current.revision, async ({ value }, signal) => {
    const refreshed = await refreshClaudeCredential(value, { ...options, signal });
    return {
      value: refreshed,
      metadata: {
        expiresAt: refreshed.expiresAt,
        ...optionalField('accountLabel', refreshed.email),
      },
    };
  });
  return (await waitForCaller(refreshing, options.signal)).snapshot.value;
}

async function resolveRefreshIdentity(
  current: ClaudeCredential,
  token: unknown,
  fetch: RuntimeFetch,
  signal: AbortSignal | undefined,
): Promise<ClaudeIdentity> {
  if (current.accountId !== undefined && current.email !== undefined) return {};
  return await resolveClaudeIdentity(token, { fetch, signal, phase: 'refresh' });
}

async function parseSuccessfulToken(response: Response): Promise<{
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn: number;
  readonly raw: unknown;
}> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    throw error instanceof SyntaxError ? refreshError(false, 'invalid') : refreshError(true, 'network');
  }
  if (!isPlainObject(raw)) throw refreshError(false, 'invalid');
  const accessToken = requiredTokenString(raw['access_token']);
  const refreshToken = requiredTokenString(raw['refresh_token']);
  const expiresIn = raw['expires_in'];
  if (accessToken === undefined || !isPositiveNumber(expiresIn)) throw refreshError(false, 'invalid');
  return { accessToken, ...(refreshToken === undefined ? {} : { refreshToken }), expiresIn, raw };
}

async function classifyFailedResponse(response: Response): Promise<CredentialRefreshError> {
  const oauthError = await readOAuthError(response);
  if (oauthError === 'invalid_grant') return refreshError(false, 'invalid_grant', response.status);
  if (response.status === 401 || response.status === 403 || oauthError === 'invalid_client') {
    return refreshError(false, 'rejected', response.status);
  }
  if (response.status >= 500) return refreshError(true, 'upstream_5xx', response.status);
  if (response.status === 408 || response.status === 429) return refreshError(true, 'http', response.status);
  return refreshError(false, 'http', response.status);
}

async function readOAuthError(response: Response): Promise<string | undefined> {
  try {
    const value: unknown = await response.json();
    return isPlainObject(value) ? requiredTokenString(value['error']) : undefined;
  } catch {
    return undefined;
  }
}

function refreshError(retryable: boolean, reason: string, status?: number): CredentialRefreshError {
  return new CredentialRefreshError('Claude credential refresh failed', {
    retryable,
    reason,
    ...(status === undefined ? {} : { status }),
  });
}

function requiredTokenString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function optionalField<K extends string>(key: K, value: string | undefined): { readonly [P in K]?: string } {
  if (value === undefined) return {};
  const field: { [P in K]?: string } = {};
  field[key] = value;
  return field;
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
