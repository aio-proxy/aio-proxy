import type { CredentialPort, OAuthLoginContext } from "@aio-proxy/plugin-sdk";

import type { GitHubCopilotCredential } from "../src";

export function loginContext(
  overrides: Partial<OAuthLoginContext> & {
    readonly presentDeviceCode?: OAuthLoginContext["authorization"]["presentDeviceCode"];
  } = {},
): OAuthLoginContext {
  const { presentDeviceCode, ...context } = overrides;
  return {
    authorization: {
      presentDeviceCode: presentDeviceCode ?? (async () => undefined),
      loopback: async () => {
        throw new Error("unexpected loopback flow");
      },
    },
    progress: () => undefined,
    signal: new AbortController().signal,
    ...context,
  };
}

export function credentialPort(initial: GitHubCopilotCredential, refreshSignal = new AbortController().signal) {
  let snapshot = { value: initial, revision: 1 };
  return {
    port: {
      read: async () => snapshot,
      refresh: async (expectedRevision, exchange) => {
        if (expectedRevision !== snapshot.revision) return { status: "superseded" as const, snapshot };
        const refreshed = await exchange(snapshot, refreshSignal);
        snapshot = { value: refreshed.value, revision: snapshot.revision + 1 };
        return { status: "updated" as const, snapshot };
      },
    } satisfies CredentialPort<GitHubCopilotCredential>,
    current: () => snapshot,
  };
}

export async function withFetchMock<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export function deviceFlowFetch(
  options: {
    readonly expiresIn?: number;
    readonly interval?: number;
    readonly tokenResponses?: readonly Record<string, string>[];
    readonly onRequest?: (url: URL) => void;
    readonly onTokenPoll?: () => void;
  } = {},
): typeof fetch {
  const tokenResponses = [...(options.tokenResponses ?? [{ access_token: "github-token" }])];
  return async (input) => {
    const url = new URL(input.toString());
    options.onRequest?.(url);
    if (url.pathname === "/login/device/code") {
      return Response.json({
        device_code: "device",
        user_code: "ABCD",
        verification_uri: "https://github.com/login/device",
        verification_uri_complete: "https://github.com/login/device?user_code=ABCD",
        interval: options.interval ?? 0,
        expires_in: options.expiresIn ?? 600,
      });
    }
    if (url.pathname === "/login/oauth/access_token") {
      options.onTokenPoll?.();
      return Response.json(tokenResponses.shift() ?? tokenResponses.at(-1) ?? { error: "authorization_pending" });
    }
    if (url.pathname === "/copilot_internal/v2/token") {
      return Response.json({
        token: "tid=x;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
        expires_at: 9_999_999_999,
      });
    }
    if (url.pathname === "/user") return Response.json({ id: 12345, login: "octocat" });
    return Response.json({ error: `unexpected ${url.pathname}` }, { status: 404 });
  };
}
