import { describe, expect, test } from "bun:test";
import type { CredentialPort } from "@aio-proxy/plugin-sdk";
import { withFetchMock } from "../../_test/test-support";
import { currentGitHubCopilotCredential, fetchCopilotToken, type GitHubCopilotCredential } from ".";

describe("GitHub Copilot credential", () => {
  test("calculates token expiry in milliseconds", async () => {
    const result = await withFetchMock(
      async () => Response.json({ token: "copilot-token", expires_at: 9_999_999_999 }),
      () => fetchCopilotToken("https://api.github.com", "github-token", new AbortController().signal),
    );

    expect(result).toEqual({ access: "copilot-token", expires: 9_999_999_999_000 });
  });

  test("refreshes an expired token with the credential port signal", async () => {
    const refreshSignal = new AbortController().signal;
    const credentials = credentialPort(
      {
        githubToken: "github-token",
        copilotToken: "stale-token",
        expiresAt: 0,
        baseURL: "https://stale.example",
      },
      refreshSignal,
    );
    const refreshSignals: AbortSignal[] = [];

    const current = await withFetchMock(
      async (_input, init) => {
        refreshSignals.push(init?.signal as AbortSignal);
        return Response.json({
          token: "tid=x;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
          expires_at: 9_999_999_999,
        });
      },
      () => currentGitHubCopilotCredential(credentials.port),
    );

    expect(refreshSignals).toEqual([refreshSignal]);
    expect(current).toEqual({
      githubToken: "github-token",
      copilotToken: "tid=x;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
      expiresAt: 9_999_999_999_000,
      baseURL: "https://api.individual.githubcopilot.com",
    });
    expect(credentials.current()).toEqual({ value: current, revision: 2 });
  });
});

function credentialPort(initial: GitHubCopilotCredential, refreshSignal: AbortSignal) {
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
