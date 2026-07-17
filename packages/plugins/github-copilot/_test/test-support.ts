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
