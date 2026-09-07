import type { OAuthLoginContext, OAuthLoginResult, RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import { generatePKCE } from '../pkce/index';
import type { OpenRouterCredential } from '../schema/index';

const AUTHORIZE_URL = 'https://openrouter.ai/auth';
const TOKEN_URL = 'https://openrouter.ai/api/v1/auth/keys';

export type OpenRouterOAuthOptions = {
  readonly fetch?: RuntimeFetch;
};

export function openRouterLoginResult(credential: OpenRouterCredential): OAuthLoginResult<OpenRouterCredential> {
  const material = credential.userId === undefined ? `key:${credential.apiKey}` : `account:${credential.userId}`;
  const digest = new Bun.CryptoHasher('sha256').update(material).digest('hex');
  return {
    fingerprint: `sha256:${digest}`,
    suggestedKey: `openrouter-${digest.slice(0, 12)}`,
    accountLabel: 'OpenRouter',
    credentials: credential,
  };
}

export async function loginOpenRouter(
  context: OAuthLoginContext,
  options: OpenRouterOAuthOptions = {},
): Promise<OAuthLoginResult<OpenRouterCredential>> {
  const pkce = await generatePKCE();
  const state = crypto.randomUUID();
  const { code } = await context.authorization.loopback({
    state,
    redirect: { hostname: '127.0.0.1', port: 'dynamic', path: '/callback' },
    allowManualCallbackUrl: true,
    authorizationUrl: ({ redirectUri }) => {
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set('callback_url', redirectUri);
      url.searchParams.set('code_challenge', pkce.challenge);
      url.searchParams.set('code_challenge_method', 'S256');
      return url.href;
    },
  });
  if (code.trim() === '') throw new Error('OpenRouter authorization code is missing');
  const credential = await exchangeAuthorizationCode(code, pkce.verifier, {
    fetch: options.fetch ?? context.fetch ?? globalThis.fetch,
    signal: context.signal,
  });
  return openRouterLoginResult(credential);
}

async function exchangeAuthorizationCode(
  code: string,
  verifier: string,
  options: { readonly fetch: RuntimeFetch; readonly signal: AbortSignal },
): Promise<OpenRouterCredential> {
  options.signal.throwIfAborted();
  let response: Response;
  try {
    response = await options.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: 'S256',
      }),
      signal: options.signal,
      aioProxy: { traffic: 'control' },
    });
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason;
    throw error;
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('OpenRouter OAuth returned invalid JSON');
  }
  if (!response.ok) {
    throw new Error(`OpenRouter OAuth key exchange failed (HTTP ${response.status})`);
  }
  if (!isPlainObject(body) || typeof body['key'] !== 'string' || body['key'].trim() === '') {
    throw new Error('OpenRouter OAuth response carries no key');
  }
  const userId =
    typeof body['user_id'] === 'string' && body['user_id'].trim() !== '' ? body['user_id'].trim() : undefined;
  return userId === undefined ? { apiKey: body['key'].trim() } : { apiKey: body['key'].trim(), userId };
}
