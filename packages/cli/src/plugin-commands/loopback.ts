import { m } from "@aio-proxy/i18n";
import type { LoopbackRequest } from "@aio-proxy/plugin-sdk";
import type { CliAuthorizationDeps } from "./authorization";

const LOOPBACK_TIMEOUT_MS = 10 * 60_000;

export class AuthorizationUrlInvalidError extends Error {
  override readonly name = "AuthorizationUrlInvalidError";

  constructor() {
    super(m.cli_oauth_error_authorization_url_invalid());
  }
}

export class LoopbackRequestInvalidError extends Error {
  override readonly name = "LoopbackRequestInvalidError";

  constructor() {
    super(m.cli_oauth_error_loopback_request_invalid());
  }
}

export class LoopbackCallbackInvalidError extends Error {
  override readonly name = "LoopbackCallbackInvalidError";

  constructor() {
    super(m.cli_oauth_error_callback_invalid());
  }
}

export class LoopbackCallbackMismatchError extends Error {
  override readonly name = "LoopbackCallbackMismatchError";

  constructor() {
    super(m.cli_oauth_error_callback_mismatch());
  }
}

export class LoopbackStateMismatchError extends Error {
  override readonly name = "LoopbackStateMismatchError";

  constructor() {
    super(m.cli_oauth_error_state_mismatch());
  }
}

export class LoopbackCodeMissingError extends Error {
  override readonly name = "LoopbackCodeMissingError";

  constructor() {
    super(m.cli_oauth_error_code_missing());
  }
}

export class LoopbackOAuthError extends Error {
  override readonly name = "LoopbackOAuthError";

  constructor() {
    super(m.cli_oauth_error_provider_denied());
  }
}

export class LoopbackTimeoutError extends Error {
  override readonly name = "LoopbackTimeoutError";

  constructor() {
    super(m.cli_oauth_error_timeout());
  }
}

export class LoopbackAbortedError extends Error {
  override readonly name = "LoopbackAbortedError";

  constructor() {
    super(m.cli_oauth_error_aborted());
  }
}

export class LoopbackPortUnavailableError extends Error {
  override readonly name = "LoopbackPortUnavailableError";

  constructor(readonly port: number) {
    super(m.cli_oauth_error_port_unavailable({ port }));
  }
}

export class LoopbackManualInputError extends Error {
  override readonly name = "LoopbackManualInputError";

  constructor() {
    super(m.cli_oauth_error_manual_input());
  }
}

export class LoopbackManualConfirmationError extends Error {
  override readonly name = "LoopbackManualConfirmationError";

  constructor() {
    super(m.cli_oauth_error_manual_confirmation());
  }
}

export class LoopbackAuthorizationUrlBuildError extends Error {
  override readonly name = "LoopbackAuthorizationUrlBuildError";

  constructor() {
    super(m.cli_oauth_error_authorization_url_build());
  }
}

type LoopbackResult = { readonly code: string; readonly redirectUri: string };
type Settlement = { readonly ok: true; readonly value: LoopbackResult } | { readonly ok: false; readonly error: Error };
type LoopbackServer = ReturnType<typeof Bun.serve>;
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

function requireValidRequest(request: LoopbackRequest): void {
  try {
    const value: unknown = request;
    if (typeof value !== "object" || value === null) {
      invalidLoopbackRequest();
    }
    const candidate = value as UntrustedLoopbackRequest;
    const state = candidate.state;
    const redirect = candidate.redirect;
    const authorizationUrl = candidate.authorizationUrl;
    const allowManualCallbackUrl = candidate.allowManualCallbackUrl;
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
    const redirectValue = redirect as UntrustedRedirect;
    const hostname = redirectValue.hostname;
    const port = redirectValue.port;
    const path = redirectValue.path;
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
    if (error instanceof LoopbackRequestInvalidError) {
      throw error;
    }
    throw new LoopbackRequestInvalidError();
  }
}

function requireHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AuthorizationUrlInvalidError();
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AuthorizationUrlInvalidError();
  }
  return url;
}

function redirectUri(request: LoopbackRequest, port: number): string {
  return `http://${request.redirect.hostname}:${port}${request.redirect.path}`;
}

function isSafeCallbackError(error: unknown): error is Error {
  return (
    error instanceof LoopbackCallbackInvalidError ||
    error instanceof LoopbackCallbackMismatchError ||
    error instanceof LoopbackStateMismatchError ||
    error instanceof LoopbackCodeMissingError ||
    error instanceof LoopbackOAuthError
  );
}

function parseCallback(raw: string, expectedRedirectUri: string, expectedState: string): { readonly code: string } {
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
  if (callback.searchParams.get("state") !== expectedState) {
    throw new LoopbackStateMismatchError();
  }
  if (callback.searchParams.get("error") !== null) {
    throw new LoopbackOAuthError();
  }
  const code = callback.searchParams.get("code");
  if (code === null || code.length === 0) {
    throw new LoopbackCodeMissingError();
  }
  return { code };
}

export async function runLoopbackAuthorization(
  request: LoopbackRequest,
  deps: CliAuthorizationDeps,
): Promise<LoopbackResult> {
  requireValidRequest(request);
  if (deps.signal.aborted) {
    throw new LoopbackAbortedError();
  }

  let server: LoopbackServer | undefined;
  let expectedRedirectUri = "";
  let authorizationUrl = "";
  let settled = false;
  let resolveResult: (value: LoopbackResult) => void = () => {};
  let rejectResult: (error: Error) => void = () => {};
  const result = new Promise<LoopbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  const losingPath = new AbortController();

  const settle = (settlement: Settlement, afterResponse = false): boolean => {
    if (settled) {
      return false;
    }
    settled = true;
    losingPath.abort();
    const publish = () => {
      if (settlement.ok) {
        resolveResult(settlement.value);
      } else {
        rejectResult(settlement.error);
      }
    };
    if (afterResponse) {
      setTimeout(publish, 0);
    } else {
      publish();
    }
    return true;
  };

  const handleCallback = (raw: string): Response => {
    if (settled) {
      return new Response(deps.copy.alreadyCompleted, { status: 409 });
    }
    try {
      const { code } = parseCallback(raw, expectedRedirectUri, request.state);
      if (!settle({ ok: true, value: { code, redirectUri: expectedRedirectUri } }, true)) {
        return new Response(deps.copy.alreadyCompleted, { status: 409 });
      }
      return new Response(deps.copy.successHtml, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    } catch (error) {
      if (error instanceof LoopbackOAuthError) {
        settle({ ok: false, error }, true);
      } else if (!isSafeCallbackError(error)) {
        return new Response(deps.copy.invalidCallback, { status: 400 });
      }
      return new Response(deps.copy.invalidCallback, { status: 400 });
    }
  };

  try {
    const requestedPort = request.redirect.port === "dynamic" ? 0 : request.redirect.port;
    try {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: requestedPort,
        fetch(incoming) {
          const incomingUrl = new URL(incoming.url);
          if (incomingUrl.pathname !== request.redirect.path) {
            return new Response(deps.copy.notFound, { status: 404 });
          }
          return handleCallback(incoming.url);
        },
      });
      if (server.port === undefined) {
        throw new LoopbackPortUnavailableError(requestedPort);
      }
      expectedRedirectUri = redirectUri(request, server.port);
    } catch {
      if (request.redirect.port === "dynamic") {
        throw new LoopbackPortUnavailableError(0);
      }
      expectedRedirectUri = redirectUri(request, request.redirect.port);
      if (request.allowManualCallbackUrl && process.stdin.isTTY === true) {
        let confirmed: boolean;
        try {
          confirmed = await deps.confirmManualOnly(expectedRedirectUri);
        } catch {
          throw new LoopbackManualConfirmationError();
        }
        if (!confirmed) {
          throw new LoopbackPortUnavailableError(request.redirect.port);
        }
      } else {
        throw new LoopbackPortUnavailableError(request.redirect.port);
      }
    }

    if (deps.signal.aborted) {
      throw new LoopbackAbortedError();
    }
    let builtAuthorizationUrl: string;
    try {
      builtAuthorizationUrl = request.authorizationUrl({ redirectUri: expectedRedirectUri });
    } catch (error) {
      if (error instanceof AuthorizationUrlInvalidError) {
        throw error;
      }
      throw new LoopbackAuthorizationUrlBuildError();
    }
    authorizationUrl = requireHttpUrl(builtAuthorizationUrl).href;
    if (deps.signal.aborted) {
      throw new LoopbackAbortedError();
    }
    deps.print(authorizationUrl);
    let opened = false;
    try {
      opened = deps.openBrowser(authorizationUrl);
    } catch {
      opened = false;
    }
    if (opened) {
      deps.print(deps.copy.openedAuthorizationPage);
    }

    const combinedSignal = AbortSignal.any([deps.signal, losingPath.signal]);
    const abort = () => {
      if (deps.signal.aborted) {
        settle({ ok: false, error: new LoopbackAbortedError() });
      }
    };
    deps.signal.addEventListener("abort", abort, { once: true });
    abort();

    const now = deps.now ?? Date.now;
    const startedAt = now();
    const timeout = setTimeout(
      () => settle({ ok: false, error: new LoopbackTimeoutError() }),
      Math.max(0, LOOPBACK_TIMEOUT_MS - (now() - startedAt)),
    );

    if (request.allowManualCallbackUrl && process.stdin.isTTY === true) {
      void (async () => {
        while (!combinedSignal.aborted) {
          let raw: string;
          try {
            raw = await deps.readManualCallbackUrl(authorizationUrl, combinedSignal);
          } catch {
            if (combinedSignal.aborted) {
              return;
            }
            settle({ ok: false, error: new LoopbackManualInputError() });
            return;
          }
          try {
            const { code } = parseCallback(raw, expectedRedirectUri, request.state);
            settle({ ok: true, value: { code, redirectUri: expectedRedirectUri } });
            return;
          } catch (error) {
            if (error instanceof LoopbackOAuthError) {
              settle({ ok: false, error });
              return;
            }
            deps.print(isSafeCallbackError(error) ? error.message : new LoopbackCallbackInvalidError().message);
          }
        }
      })();
    }

    try {
      return await result;
    } finally {
      clearTimeout(timeout);
      deps.signal.removeEventListener("abort", abort);
    }
  } finally {
    losingPath.abort();
    if (server !== undefined) {
      await server.stop();
    }
  }
}
