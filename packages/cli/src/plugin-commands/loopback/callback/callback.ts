import type { LoopbackRequest } from '@aio-proxy/plugin-sdk';
import { resolveOAuthLoopbackCallback } from '@aio-proxy/shared';

import {
  AuthorizationUrlInvalidError,
  LoopbackCallbackInvalidError,
  LoopbackCallbackMismatchError,
  LoopbackCodeMissingError,
  LoopbackOAuthError,
  LoopbackRequestInvalidError,
  LoopbackStateMismatchError,
} from '../errors';

type UntrustedLoopbackRequest = {
  readonly state?: unknown;
  readonly redirect?: unknown;
  readonly authorizationUrl?: unknown;
  readonly allowManualCallbackUrl?: unknown;
};

type UntrustedRedirect = {
  readonly hostname?: unknown;
  readonly port?: unknown;
  readonly path?: unknown;
};

function invalidLoopbackRequest(): never {
  throw new LoopbackRequestInvalidError();
}

export function requireValidRequest(request: LoopbackRequest): void {
  try {
    const value: unknown = request;
    if (typeof value !== 'object' || value === null) invalidLoopbackRequest();
    const candidate = value as UntrustedLoopbackRequest;
    const { state, redirect, authorizationUrl, allowManualCallbackUrl } = candidate;
    if (
      typeof state !== 'string' ||
      state.trim().length === 0 ||
      typeof redirect !== 'object' ||
      redirect === null ||
      typeof authorizationUrl !== 'function' ||
      typeof allowManualCallbackUrl !== 'boolean'
    ) {
      invalidLoopbackRequest();
    }
    const { hostname, port, path } = redirect as UntrustedRedirect;
    if (
      (hostname !== 'localhost' && hostname !== '127.0.0.1') ||
      (port !== 'dynamic' && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65_535)) ||
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.includes('?') ||
      path.includes('#')
    ) {
      invalidLoopbackRequest();
    }
  } catch (error) {
    if (error instanceof LoopbackRequestInvalidError) throw error;
    throw new LoopbackRequestInvalidError();
  }
}

export function requireHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthorizationUrlInvalidError();
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AuthorizationUrlInvalidError();
  return url;
}

export function redirectUri(request: LoopbackRequest, port: number): string {
  return `http://${request.redirect.hostname}:${port}${request.redirect.path}`;
}

export function isSafeCallbackError(error: unknown): error is Error {
  return (
    error instanceof LoopbackCallbackInvalidError ||
    error instanceof LoopbackCallbackMismatchError ||
    error instanceof LoopbackStateMismatchError ||
    error instanceof LoopbackCodeMissingError ||
    error instanceof LoopbackOAuthError
  );
}

export function parseCallback(
  raw: string,
  expectedRedirectUri: string,
  expectedState: string,
  options: { readonly stateRequired?: boolean } = {},
): { readonly code: string } {
  const resolved = resolveOAuthLoopbackCallback(raw, expectedRedirectUri, expectedState, {
    stateRequired: options.stateRequired ?? true,
  });
  if (resolved.ok) return { code: resolved.code };
  switch (resolved.reason) {
    case 'invalid':
      throw new LoopbackCallbackInvalidError();
    case 'mismatch':
      throw new LoopbackCallbackMismatchError();
    case 'state_mismatch':
      throw new LoopbackStateMismatchError();
    case 'denied':
      throw new LoopbackOAuthError();
    case 'code_missing':
      throw new LoopbackCodeMissingError();
  }
}
