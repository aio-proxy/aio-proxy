import type { AuthorizationPort, LoopbackRequest } from "@aio-proxy/plugin-sdk";
import type { DashboardOAuthSession } from "@aio-proxy/types";

import { m } from "@aio-proxy/i18n";

import { loopbackRedirectUri, OAuthCallbackError, parseOAuthCallback, requireHttpUrl } from "./callback";

type LoopbackResult = { readonly code: string; readonly redirectUri: string };
type LoopbackServer = ReturnType<typeof Bun.serve>;

export type DashboardAuthorization = {
  readonly port: AuthorizationPort;
  readonly submitCallback: (raw: string) => void;
  readonly close: () => void;
};

export const createDashboardAuthorization = (options: {
  readonly sessionId: string;
  readonly signal: AbortSignal;
  readonly publish: (session: DashboardOAuthSession) => void;
}): DashboardAuthorization => {
  let submit: ((raw: string) => void) | undefined;
  let closeCurrent = () => {};

  const loopback = async (request: LoopbackRequest): Promise<LoopbackResult> => {
    let server: LoopbackServer | undefined;
    const requestedPort = request.redirect.port === "dynamic" ? 0 : request.redirect.port;
    let expectedRedirectUri: string;
    let settled = false;
    let resolveResult = (_value: LoopbackResult) => {};
    let rejectResult = (_error: unknown) => {};
    const result = new Promise<LoopbackResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const settle = (
      value: { readonly ok: true; readonly result: LoopbackResult } | { readonly ok: false; error: unknown },
    ) => {
      if (settled) return false;
      settled = true;
      if (value.ok) resolveResult(value.result);
      else rejectResult(value.error);
      return true;
    };

    const accept = (raw: string): void => {
      try {
        const { code } = parseOAuthCallback(raw, expectedRedirectUri, request.state);
        settle({ ok: true, result: { code, redirectUri: expectedRedirectUri } });
      } catch (error) {
        if (error instanceof OAuthCallbackError && error.code === "AUTHORIZATION_DENIED") {
          settle({ ok: false, error });
        }
        throw error;
      }
    };

    try {
      try {
        server = Bun.serve({
          hostname: "127.0.0.1",
          port: requestedPort,
          fetch(incoming) {
            const url = new URL(incoming.url);
            if (url.pathname !== request.redirect.path) {
              return new Response(m.cli_oauth_callback_not_found(), { status: 404 });
            }
            try {
              accept(incoming.url);
              return new Response(m.cli_oauth_success_html(), {
                headers: { "content-type": "text/html; charset=utf-8" },
              });
            } catch {
              return new Response(m.cli_oauth_invalid_callback_response(), { status: 400 });
            }
          },
        });
      } catch {
        if (request.redirect.port === "dynamic" || !request.allowManualCallbackUrl) {
          throw new OAuthCallbackError("CALLBACK_PORT_UNAVAILABLE");
        }
      }
      const port = server?.port ?? requestedPort;
      if (port === 0) throw new OAuthCallbackError("CALLBACK_PORT_UNAVAILABLE");
      expectedRedirectUri = loopbackRedirectUri(request, port);
      const authorizationUrl = requireHttpUrl(request.authorizationUrl({ redirectUri: expectedRedirectUri })).href;
      submit = accept;
      options.publish({
        id: options.sessionId,
        status: "loopback",
        authorizationUrl,
        allowManualCallback: request.allowManualCallbackUrl,
      });

      const abort = () => settle({ ok: false, error: options.signal.reason });
      options.signal.addEventListener("abort", abort, { once: true });
      closeCurrent = () => {
        options.signal.removeEventListener("abort", abort);
        submit = undefined;
        void server?.stop();
      };
      try {
        if (options.signal.aborted) abort();
        return await result;
      } finally {
        closeCurrent();
      }
    } catch (error) {
      await server?.stop();
      throw error;
    }
  };

  return {
    port: {
      async presentDeviceCode(input) {
        options.publish({
          id: options.sessionId,
          status: "device_code",
          url: requireHttpUrl(input.url).href,
          userCode: input.userCode,
          ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        });
      },
      loopback,
    },
    submitCallback(raw) {
      if (submit === undefined) throw new OAuthCallbackError("CALLBACK_NOT_EXPECTED");
      submit(raw);
    },
    close() {
      closeCurrent();
    },
  };
};
