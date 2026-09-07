import type { LocalizedText, OAuthLoginContext, RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { generatePKCE, generateState } from '../pkce';
import type { ClaudeCredential } from '../schema';
import { CLAUDE_AUTHORIZE_URL, CLAUDE_CLIENT_ID, CLAUDE_LOOPBACK, CLAUDE_SCOPE, CLAUDE_TOKEN_URL } from './constants';
import { resolveClaudeIdentity } from './identity';

export function buildClaudeAuthorizationUrl(input: {
  readonly challenge: string;
  readonly redirectUri: string;
  readonly state: string;
}): string {
  const url = new URL(CLAUDE_AUTHORIZE_URL);
  url.searchParams.set('client_id', CLAUDE_CLIENT_ID);
  url.searchParams.set('code', 'true');
  url.searchParams.set('code_challenge', input.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', CLAUDE_SCOPE);
  url.searchParams.set('state', input.state);
  return url.toString();
}

export function normalizeClaudeEmail(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return email === '' ? undefined : email;
}

export class ClaudeIdentityMissingError extends Error {
  override readonly name = 'ClaudeIdentityMissingError';
  constructor() {
    super('Claude login did not return a stable account identity');
  }
}

export function claudeLoginResult(credentials: ClaudeCredential) {
  const email = normalizeClaudeEmail(credentials.email);
  const accountId = credentials.accountId?.trim() || undefined;
  const organizationId = credentials.organizationId?.trim() || undefined;
  const organizationName = credentials.organizationName?.trim() || undefined;
  if (accountId === undefined) {
    throw new ClaudeIdentityMissingError();
  }
  const normalized: ClaudeCredential = {
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
    ...(email === undefined ? {} : { email }),
    ...(accountId === undefined ? {} : { accountId }),
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(organizationName === undefined ? {} : { organizationName }),
  };
  const identity = `account:${normalized.accountId}`;
  const digest = new Bun.CryptoHasher('sha256').update(identity).digest('hex');
  return {
    fingerprint: `sha256:${digest}`,
    suggestedKey: `claude-${digest.slice(0, 12)}`,
    accountLabel: normalized.email ?? normalized.organizationName ?? 'Claude Pro/Max',
    credentials: normalized,
    expiresAt: normalized.expiresAt,
  };
}

export type ClaudeOAuthDependencies = {
  readonly fetch?: RuntimeFetch;
  readonly now?: () => number;
};

export class ClaudeTokenExchangeError extends Error {
  override readonly name = 'ClaudeTokenExchangeError';
  constructor(readonly status: number) {
    super(`Claude token exchange failed with status ${status}`);
  }
}

export async function loginClaude(
  context: OAuthLoginContext,
  presentation: { readonly waiting: LocalizedText },
  options: ClaudeOAuthDependencies = {},
) {
  const pkce = await generatePKCE();
  const state = generateState();
  context.progress(presentation.waiting);
  const { code, redirectUri } = await context.authorization.loopback({
    state,
    redirect: { ...CLAUDE_LOOPBACK },
    authorizationUrl: ({ redirectUri: selected }) =>
      buildClaudeAuthorizationUrl({ challenge: pkce.challenge, redirectUri: selected, state }),
    allowManualCallbackUrl: true,
  });
  const fetcher = options.fetch ?? context.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const token = await exchangeClaudeAuthorizationCode(code, pkce.verifier, redirectUri, state, {
    fetch: fetcher,
    signal: context.signal,
  });
  const identity = await resolveClaudeIdentity(token.raw, { fetch: fetcher, signal: context.signal, phase: 'login' });
  return claudeLoginResult({
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: now() + token.expiresIn * 1000 - 5 * 60_000,
    ...identity,
  });
}

export async function exchangeClaudeAuthorizationCode(
  code: string,
  verifier: string,
  redirectUri: string,
  state: string,
  options: { readonly fetch: RuntimeFetch; readonly signal?: AbortSignal },
) {
  const fetcher = options.fetch ?? globalThis.fetch;
  const response = await fetcher(CLAUDE_TOKEN_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: CLAUDE_CLIENT_ID,
      code_verifier: verifier,
      state,
    }),
    aioProxy: { traffic: 'control' },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) throw new ClaudeTokenExchangeError(response.status);
  const raw: unknown = await response.json();
  if (!isPlainObject(raw)) throw new Error('Claude token exchange returned an invalid payload');
  const accessToken = requiredTokenString(raw['access_token']);
  const refreshToken = requiredTokenString(raw['refresh_token']);
  const expiresIn = raw['expires_in'];
  if (accessToken === undefined || refreshToken === undefined || !isPositiveNumber(expiresIn)) {
    throw new Error('Claude token exchange returned an invalid payload');
  }
  return { accessToken, refreshToken, expiresIn, raw };
}

function requiredTokenString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}
