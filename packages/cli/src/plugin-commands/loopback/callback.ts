import type { LoopbackRequest } from "@aio-proxy/plugin-sdk";

import {
  AuthorizationUrlInvalidError,
  LoopbackCallbackInvalidError,
  LoopbackCallbackMismatchError,
  LoopbackCodeMissingError,
  LoopbackOAuthError,
  LoopbackRequestInvalidError,
  LoopbackStateMismatchError,
} from "./errors";

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
    if (typeof value !== "object" || value === null) invalidLoopbackRequest();
    const candidate = value as UntrustedLoopbackRequest;
    const { state, redirect, authorizationUrl, allowManualCallbackUrl } = candidate;
    if (
      typeof state !== "string" ||
      state.trim().length === 0 ||
      typeof redirect !== "object" ||
      redirect === null ||
      typeof authorizationUrl !== "function" ||
      typeof allowManualCallbackUrl !== "boolean"
    ) {
      invalidLoopbackRequest();
    }
    const { hostname, port, path } = redirect as UntrustedRedirect;
    if (
      (hostname !== "localhost" && hostname !== "127.0.0.1") ||
      (port !== "dynamic" && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535)) ||
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.includes("?") ||
      path.includes("#")
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
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new AuthorizationUrlInvalidError();
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
): { readonly code: string } {
  let callback: URL;
  try {
    callback = new URL(raw);
  } catch {
    throw new LoopbackCallbackInvalidError();
  }
  const expected = new URL(expectedRedirectUri);
  if (
    callback.protocol !== expected.protocol ||
    callback.hostname !== expected.hostname ||
    callback.port !== expected.port ||
    callback.pathname !== expected.pathname ||
    callback.username !== "" ||
    callback.password !== "" ||
    callback.hash !== ""
  ) {
    throw new LoopbackCallbackMismatchError();
  }
  if (callback.searchParams.get("state") !== expectedState) throw new LoopbackStateMismatchError();
  if (callback.searchParams.get("error") !== null) throw new LoopbackOAuthError();
  const code = callback.searchParams.get("code");
  if (code === null || code.length === 0) throw new LoopbackCodeMissingError();
  return { code };
}
