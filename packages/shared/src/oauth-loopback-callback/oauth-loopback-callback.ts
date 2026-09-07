export type OAuthLoopbackCallbackFailureReason = 'invalid' | 'mismatch' | 'state_mismatch' | 'denied' | 'code_missing';

export type OAuthLoopbackCallbackResult =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: OAuthLoopbackCallbackFailureReason };

export function resolveOAuthLoopbackCallback(
  raw: string,
  expectedRedirectUri: string,
  expectedState: string,
  options: { readonly stateRequired: boolean },
): OAuthLoopbackCallbackResult {
  const { stateRequired } = options;
  let callback: URL;
  try {
    callback = new URL(raw);
  } catch {
    if (stateRequired) return { ok: false, reason: 'invalid' };
    return settleFromParams(new URLSearchParams(raw.trim()), expectedState, stateRequired, raw.trim());
  }

  const expected = new URL(expectedRedirectUri);
  if (
    callback.protocol !== expected.protocol ||
    callback.hostname !== expected.hostname ||
    callback.port !== expected.port ||
    callback.pathname !== expected.pathname ||
    callback.username !== '' ||
    callback.password !== '' ||
    callback.hash !== ''
  ) {
    return { ok: false, reason: 'mismatch' };
  }
  return settleFromParams(callback.searchParams, expectedState, stateRequired);
}

function settleFromParams(
  params: URLSearchParams,
  expectedState: string,
  stateRequired: boolean,
  looseRaw?: string,
): OAuthLoopbackCallbackResult {
  const state = params.get('state');
  if (stateRequired) {
    if (state !== expectedState) return { ok: false, reason: 'state_mismatch' };
  } else if (state !== null && state !== expectedState) {
    return { ok: false, reason: 'state_mismatch' };
  }

  if (params.get('error') !== null) return { ok: false, reason: 'denied' };

  const code = params.get('code');
  if (code !== null && code.length > 0) return { ok: true, code };

  if (looseRaw !== undefined && looseRaw.length > 0 && !/\s/.test(looseRaw) && !looseRaw.includes('://')) {
    return { ok: true, code: looseRaw };
  }

  return { ok: false, reason: 'code_missing' };
}
