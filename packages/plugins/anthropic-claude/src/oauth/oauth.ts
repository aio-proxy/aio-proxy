import type { ClaudeCredential } from '../schema';
import { CLAUDE_AUTHORIZE_URL, CLAUDE_CLIENT_ID, CLAUDE_SCOPE } from './constants';

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
