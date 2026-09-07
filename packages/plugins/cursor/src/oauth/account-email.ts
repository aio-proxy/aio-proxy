import type { RuntimeFetch } from '@aio-proxy/plugin-sdk';
import { isPlainObject } from 'es-toolkit/predicate';

import type { CursorCredential } from '../schema';
import { cursorSessionCookie } from '../session-cookie';

export async function readCursorAccountEmail(
  credential: Pick<CursorCredential, 'accessToken' | 'subject'>,
  fetcher: RuntimeFetch,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  try {
    // Account presentation must not hold up an otherwise usable login or token refresh.
    const timeout = AbortSignal.timeout(3_000);
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    const response = await fetcher('https://cursor.com/api/auth/me', {
      headers: {
        Accept: 'application/json',
        Cookie: cursorSessionCookie(credential.accessToken, credential.subject),
      },
      redirect: 'error',
      signal: requestSignal,
      aioProxy: { traffic: 'control' },
    });
    requestSignal.throwIfAborted();
    if (!response.ok) {
      await response.body?.cancel();
      return undefined;
    }
    const payload: unknown = await response.json();
    requestSignal.throwIfAborted();
    if (!isPlainObject(payload)) return undefined;
    const email: unknown = Reflect.get(payload, 'email');
    return typeof email === 'string' ? email.trim().toLowerCase() || undefined : undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}
