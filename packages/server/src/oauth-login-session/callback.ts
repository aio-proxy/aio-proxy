import type { LoopbackRequest } from '@aio-proxy/plugin-sdk';
import { resolveOAuthLoopbackCallback } from '@aio-proxy/shared';

export class OAuthCallbackError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'OAuthCallbackError';
  }
}

export const requireHttpUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthCallbackError('AUTHORIZATION_URL_INVALID');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OAuthCallbackError('AUTHORIZATION_URL_INVALID');
  }
  return url;
};

export const loopbackRedirectUri = (request: LoopbackRequest, port: number): string =>
  `http://${request.redirect.hostname}:${port}${request.redirect.path}`;

export const parseOAuthCallback = (
  raw: string,
  expectedRedirectUri: string,
  expectedState: string,
  options: { readonly stateRequired?: boolean } = {},
): { readonly code: string } => {
  const resolved = resolveOAuthLoopbackCallback(raw, expectedRedirectUri, expectedState, {
    stateRequired: options.stateRequired ?? true,
  });
  if (resolved.ok) return { code: resolved.code };
  switch (resolved.reason) {
    case 'invalid':
      throw new OAuthCallbackError('CALLBACK_INVALID');
    case 'mismatch':
      throw new OAuthCallbackError('CALLBACK_MISMATCH');
    case 'state_mismatch':
      throw new OAuthCallbackError('CALLBACK_STATE_MISMATCH');
    case 'denied':
      throw new OAuthCallbackError('AUTHORIZATION_DENIED');
    case 'code_missing':
      throw new OAuthCallbackError('CALLBACK_CODE_MISSING');
  }
};
