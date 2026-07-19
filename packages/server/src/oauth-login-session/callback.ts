import type { LoopbackRequest } from "@aio-proxy/plugin-sdk";

export class OAuthCallbackError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OAuthCallbackError";
  }
}

export const requireHttpUrl = (value: string): URL => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthCallbackError("AUTHORIZATION_URL_INVALID");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OAuthCallbackError("AUTHORIZATION_URL_INVALID");
  }
  return url;
};

export const loopbackRedirectUri = (request: LoopbackRequest, port: number): string =>
  `http://${request.redirect.hostname}:${port}${request.redirect.path}`;

export const parseOAuthCallback = (
  raw: string,
  expectedRedirectUri: string,
  expectedState: string,
): { readonly code: string } => {
  let callback: URL;
  try {
    callback = new URL(raw);
  } catch {
    throw new OAuthCallbackError("CALLBACK_INVALID");
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
    throw new OAuthCallbackError("CALLBACK_MISMATCH");
  }
  if (callback.searchParams.get("state") !== expectedState) throw new OAuthCallbackError("CALLBACK_STATE_MISMATCH");
  if (callback.searchParams.get("error") !== null) throw new OAuthCallbackError("AUTHORIZATION_DENIED");
  const code = callback.searchParams.get("code");
  if (code === null || code === "") throw new OAuthCallbackError("CALLBACK_CODE_MISSING");
  return { code };
};
