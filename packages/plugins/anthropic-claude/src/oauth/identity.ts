import type { RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import {
  CLAUDE_BOOTSTRAP_MODEL,
  CLAUDE_BOOTSTRAP_URL,
  CLAUDE_BOOTSTRAP_USER_AGENT,
  CLAUDE_OAUTH_BETA,
} from './constants';

export type ClaudeIdentity = {
  readonly accountId?: string;
  readonly email?: string;
  readonly organizationId?: string;
  readonly organizationName?: string;
};

export type ClaudeIdentityOptions = {
  readonly fetch?: RuntimeFetch;
  readonly signal?: AbortSignal;
  readonly phase: 'login' | 'refresh';
};

export async function resolveClaudeIdentity(token: unknown, options: ClaudeIdentityOptions): Promise<ClaudeIdentity> {
  const fromToken = readTokenIdentity(token);
  const identity = needsBootstrap(fromToken, options.phase)
    ? fillMissing(fromToken, await bootstrapIdentity(readAccessToken(token), options))
    : fromToken;
  return presentIdentity(identity, options.phase);
}

function needsBootstrap(identity: ClaudeIdentity, phase: 'login' | 'refresh'): boolean {
  if (identity.accountId === undefined || identity.email === undefined) return true;
  return phase === 'login' && identity.organizationId === undefined;
}

async function bootstrapIdentity(
  accessToken: string | undefined,
  options: ClaudeIdentityOptions,
): Promise<ClaudeIdentity> {
  if (accessToken === undefined) return {};
  const fetcher = options.fetch ?? globalThis.fetch;
  const url = new URL(CLAUDE_BOOTSTRAP_URL);
  url.searchParams.set('entrypoint', 'cli');
  url.searchParams.set('model', CLAUDE_BOOTSTRAP_MODEL);
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: {
        accept: 'application/json, text/plain, */*',
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
        'user-agent': CLAUDE_BOOTSTRAP_USER_AGENT,
        'anthropic-beta': CLAUDE_OAUTH_BETA,
      },
      aioProxy: { traffic: 'control' },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) return {};
    return readBootstrapIdentity(await response.json());
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (error instanceof Error && error.name === 'AbortError') throw error;
    return {};
  }
}

function readTokenIdentity(token: unknown): ClaudeIdentity {
  if (!isPlainObject(token)) return {};
  const account = isPlainObject(token['account']) ? token['account'] : undefined;
  const organization = isPlainObject(token['organization']) ? token['organization'] : undefined;
  return omitUndefined({
    accountId: account === undefined ? undefined : optionalString(account['uuid']),
    email: account === undefined ? undefined : normalizeEmail(account['email_address']),
    organizationId: organization === undefined ? undefined : optionalString(organization['uuid']),
    organizationName: organization === undefined ? undefined : optionalString(organization['name']),
  });
}

function readBootstrapIdentity(payload: unknown): ClaudeIdentity {
  if (!isPlainObject(payload) || !isPlainObject(payload['oauth_account'])) return {};
  const account = payload['oauth_account'];
  return omitUndefined({
    accountId: optionalString(account['account_uuid']),
    email: normalizeEmail(account['account_email']),
    organizationId: optionalString(account['organization_uuid']),
    organizationName: optionalString(account['organization_name']),
  });
}

function readAccessToken(token: unknown): string | undefined {
  if (!isPlainObject(token)) return undefined;
  return optionalString(token['access_token']);
}

function fillMissing(base: ClaudeIdentity, extra: ClaudeIdentity): ClaudeIdentity {
  return omitUndefined({
    accountId: base.accountId ?? extra.accountId,
    email: base.email ?? extra.email,
    organizationId: base.organizationId ?? extra.organizationId,
    organizationName: base.organizationName ?? extra.organizationName,
  });
}

function presentIdentity(identity: ClaudeIdentity, phase: 'login' | 'refresh'): ClaudeIdentity {
  return omitUndefined({
    accountId: identity.accountId,
    email: identity.email,
    organizationId: phase === 'refresh' ? undefined : identity.organizationId,
    organizationName: phase === 'refresh' ? undefined : identity.organizationName,
  });
}

function omitUndefined(fields: ClaudeIdentity): ClaudeIdentity {
  return {
    ...(fields.accountId === undefined ? {} : { accountId: fields.accountId }),
    ...(fields.email === undefined ? {} : { email: fields.email }),
    ...(fields.organizationId === undefined ? {} : { organizationId: fields.organizationId }),
    ...(fields.organizationName === undefined ? {} : { organizationName: fields.organizationName }),
  };
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function normalizeEmail(value: unknown): string | undefined {
  return optionalString(value)?.toLowerCase();
}
