import type { LoopbackRequest } from "@aio-proxy/plugin-sdk";
import type { CliAuthorizationDeps } from "../authorization";
import { isSafeCallbackError, parseCallback, redirectUri, requireHttpUrl, requireValidRequest } from "./callback";
import {
  AuthorizationUrlInvalidError,
  LoopbackAbortedError,
  LoopbackAuthorizationUrlBuildError,
  LoopbackCallbackInvalidError,
  LoopbackManualInputError,
  LoopbackOAuthError,
  LoopbackPortUnavailableError,
  LoopbackTimeoutError,
} from "./errors";

export * from "./errors";

const LOOPBACK_TIMEOUT_MS = 10 * 60_000;

type LoopbackResult = { readonly code: string; readonly redirectUri: string };
type Settlement = { readonly ok: true; readonly value: LoopbackResult } | { readonly ok: false; readonly error: Error };
type LoopbackServer = ReturnType<typeof Bun.serve>;

export async function runLoopbackAuthorization(
  request: LoopbackRequest,
  deps: CliAuthorizationDeps,
): Promise<LoopbackResult> {
  requireValidRequest(request);
  if (deps.signal.aborted) throw new LoopbackAbortedError();

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
    if (settled) return false;
    settled = true;
    losingPath.abort();
    const publish = () => {
      if (settlement.ok) resolveResult(settlement.value);
      else rejectResult(settlement.error);
    };
    if (afterResponse) setTimeout(publish, 0);
    else publish();
    return true;
  };

  const handleCallback = (raw: string): Response => {
    if (settled) return new Response(deps.copy.alreadyCompleted, { status: 409 });
    try {
      const { code } = parseCallback(raw, expectedRedirectUri, request.state);
      if (!settle({ ok: true, value: { code, redirectUri: expectedRedirectUri } }, true)) {
        return new Response(deps.copy.alreadyCompleted, { status: 409 });
      }
      return new Response(deps.copy.successHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    } catch (error) {
      if (error instanceof LoopbackOAuthError) settle({ ok: false, error }, true);
      else if (!isSafeCallbackError(error)) return new Response(deps.copy.invalidCallback, { status: 400 });
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
          if (incomingUrl.pathname !== request.redirect.path) return new Response(deps.copy.notFound, { status: 404 });
          return handleCallback(incoming.url);
        },
      });
      if (server.port === undefined) throw new LoopbackPortUnavailableError(requestedPort);
      expectedRedirectUri = redirectUri(request, server.port);
    } catch {
      throw new LoopbackPortUnavailableError(requestedPort);
    }

    if (deps.signal.aborted) throw new LoopbackAbortedError();
    let builtAuthorizationUrl: string;
    try {
      builtAuthorizationUrl = request.authorizationUrl({ redirectUri: expectedRedirectUri });
    } catch (error) {
      if (error instanceof AuthorizationUrlInvalidError) throw error;
      throw new LoopbackAuthorizationUrlBuildError();
    }
    authorizationUrl = requireHttpUrl(builtAuthorizationUrl).href;
    if (deps.signal.aborted) throw new LoopbackAbortedError();
    deps.print(authorizationUrl);
    let opened = false;
    try {
      opened = deps.openBrowser(authorizationUrl);
    } catch {
      opened = false;
    }
    if (opened) deps.print(deps.copy.openedAuthorizationPage);

    const combinedSignal = AbortSignal.any([deps.signal, losingPath.signal]);
    const abort = () => {
      if (deps.signal.aborted) settle({ ok: false, error: new LoopbackAbortedError() });
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
            if (combinedSignal.aborted) return;
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
    if (server !== undefined) await server.stop();
  }
}
