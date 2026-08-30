import type { LocalizedText, OAuthLoginContext, OAuthLoginResult, RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { isRecord } from '@aio-proxy/types';

import { cursorIdentity, cursorTokenExpiry } from '../jwt';
import type { CursorCredential } from '../schema';
import {
  CURSOR_LOGIN_URL,
  CURSOR_POLL_BACKOFF,
  CURSOR_POLL_BASE_DELAY_MS,
  CURSOR_POLL_MAX_ATTEMPTS,
  CURSOR_POLL_MAX_DELAY_MS,
  CURSOR_POLL_URL,
} from './constants';
import { type CursorOAuthDependencies } from './credential';

export { currentCursorCredential, refreshCursorCredential, type CursorOAuthDependencies } from './credential';

export type CursorLoginPresentation = { readonly waiting: LocalizedText };

export async function loginCursor(
  context: OAuthLoginContext,
  presentation: CursorLoginPresentation,
  dependencies: CursorOAuthDependencies = {},
): Promise<OAuthLoginResult<CursorCredential>> {
  const fetcher: RuntimeFetch = dependencies.fetch ?? context.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? abortableSleep;
  const { generateCursorPkce } = await import('../pkce');
  const { verifier, challenge } = await generateCursorPkce();
  const uuid = dependencies.uuid?.() ?? crypto.randomUUID();
  const params = new URLSearchParams({ challenge, uuid, mode: 'login', redirectTarget: 'cli' });
  await context.authorization.presentAuthorizeUrl({ url: `${CURSOR_LOGIN_URL}?${params.toString()}` });

  let delay = CURSOR_POLL_BASE_DELAY_MS;
  let consecutiveErrors = 0;
  for (let attempt = 0; attempt < CURSOR_POLL_MAX_ATTEMPTS; attempt++) {
    context.signal.throwIfAborted();
    await sleep(delay, context.signal);
    let response: Response;
    try {
      response = await fetcher(`${CURSOR_POLL_URL}?uuid=${uuid}&verifier=${verifier}`, {
        signal: context.signal,
        aioProxy: { traffic: 'control' },
      });
    } catch {
      if (context.signal.aborted) throw context.signal.reason;
      if (++consecutiveErrors >= 3) throw new Error('Cursor authentication polling failed');
      context.progress(presentation.waiting);
      continue;
    }
    if (response.status === 404) {
      consecutiveErrors = 0;
      delay = Math.min(delay * CURSOR_POLL_BACKOFF, CURSOR_POLL_MAX_DELAY_MS);
      context.progress(presentation.waiting);
      continue;
    }
    if (response.ok) return completeLogin(await response.json(), now());
    if (++consecutiveErrors >= 3) throw new Error(`Cursor authentication polling failed: ${response.status}`);
    context.progress(presentation.waiting);
  }
  throw new Error('Cursor authentication polling timed out');
}

function completeLogin(payload: unknown, now: number): OAuthLoginResult<CursorCredential> {
  if (!isRecord(payload)) {
    throw new Error('Cursor authentication returned an invalid payload');
  }
  const record = payload as Record<string, unknown>;
  const accessToken = record['accessToken'];
  const refreshToken = record['refreshToken'];
  if (
    typeof accessToken !== 'string' ||
    accessToken === '' ||
    typeof refreshToken !== 'string' ||
    refreshToken === ''
  ) {
    throw new Error('Cursor authentication returned an incomplete token');
  }
  const identity = cursorIdentity({ accessToken });
  const expiresAt = cursorTokenExpiry(accessToken, now);
  return {
    fingerprint: identity.fingerprint,
    suggestedKey: identity.suggestedKey,
    accountLabel: identity.label,
    credentials: {
      accessToken,
      refreshToken,
      expiresAt,
      ...(identity.email === undefined ? {} : { email: identity.email }),
      ...(identity.subject === undefined ? {} : { subject: identity.subject }),
    },
    expiresAt,
  };
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
