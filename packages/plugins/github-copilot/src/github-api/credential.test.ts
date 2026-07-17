import { describe, expect, test } from "bun:test";
import { credentialPort, withFetchMock } from "../../_test/test-support";
import { currentGitHubCopilotCredential, fetchCopilotToken } from ".";

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
