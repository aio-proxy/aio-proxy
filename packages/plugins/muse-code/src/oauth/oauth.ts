import type { CredentialPort } from '@aio-proxy/plugin-sdk';

import type { MuseCodeCredential } from '../schema';

export type MuseCodeOAuthOptions = {
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
};

export function normalizeMuseEmail(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const email = value.trim().toLowerCase();
  return email === '' ? undefined : email;
}

export function museLoginResult(credential: MuseCodeCredential) {
  const email = normalizeMuseEmail(credential.email);
  const accountId = credential.accountId?.trim() || undefined;
  const normalized: MuseCodeCredential = {
    oauthAccessToken: credential.oauthAccessToken,
    apiKey: credential.apiKey,
    ...(email === undefined ? {} : { email }),
    ...(accountId === undefined ? {} : { accountId }),
  };
  let identity: string | undefined;
  if (accountId !== undefined) identity = `account:${accountId}`;
  else if (email !== undefined) identity = `email:${email}`;
  if (identity === undefined) throw new Error('Muse Code key response is missing a stable account identity');
  const digest = new Bun.CryptoHasher('sha256').update(identity).digest('hex');
  return {
    fingerprint: `sha256:${digest}`,
    suggestedKey: `muse-${digest.slice(0, 12)}`,
    accountLabel: email ?? accountId ?? 'Muse Code',
    credentials: normalized,
  };
}

export async function currentMuseCodeCredential(
  port: CredentialPort<MuseCodeCredential>,
  options: MuseCodeOAuthOptions = {},
): Promise<MuseCodeCredential> {
  options.signal?.throwIfAborted();
  const current = await port.read();
  options.signal?.throwIfAborted();
  return current.value;
}
