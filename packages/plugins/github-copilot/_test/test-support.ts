import type { OAuthAdapter, PluginDescriptor } from "@aio-proxy/plugin-sdk";
import type { GitHubAccountOptions, GitHubCopilotCredential } from "../src";

export async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<GitHubAccountOptions, GitHubCopilotCredential>> {
  let registered: OAuthAdapter<GitHubAccountOptions, GitHubCopilotCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(adapter) {
          registered = adapter as unknown as OAuthAdapter<GitHubAccountOptions, GitHubCopilotCredential>;
        },
      },
    },
    undefined,
  );
  if (registered === undefined) throw new Error("GitHub Copilot OAuth adapter was not registered");
  return registered;
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
