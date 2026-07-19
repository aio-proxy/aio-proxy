import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loginToGitHubCopilot } from ".";
import { deviceFlowFetch, loginContext, withFetchMock } from "../../_test/test-support";

afterEach(() => {
  jest.useRealTimers();
});

describe("GitHub Copilot login", () => {
  test("supports injectable localized login progress copy", async () => {
    const progress: string[] = [];

    await withFetchMock(
      deviceFlowFetch({ tokenResponses: [{ error: "authorization_pending" }, { access_token: "github-token" }] }),
      () =>
        loginToGitHubCopilot(
          loginContext({ progress: (message) => progress.push(message) }),
          { deploymentType: "github.com" },
          {
            deviceInstructions: "Saisissez le code",
            refreshingToken: "Actualisation du jeton GitHub Copilot",
            waitingForAuthorization: "En attente de l’autorisation GitHub",
          },
        ),
    );

    expect(progress).toEqual(["En attente de l’autorisation GitHub", "Actualisation du jeton GitHub Copilot"]);
  });

  test("presents verification_uri_complete and returns account data without persistence", async () => {
    const presentations: unknown[] = [];
    const requestedPaths: string[] = [];
    const previousHome = process.env.AIO_PROXY_HOME;
    const home = mkdtempSync(join(tmpdir(), "aio-proxy-copilot-plugin-"));
    process.env.AIO_PROXY_HOME = home;

    try {
      const result = await withFetchMock(
        deviceFlowFetch({ onRequest: (url) => requestedPaths.push(url.pathname) }),
        () =>
          loginToGitHubCopilot(
            loginContext({
              presentDeviceCode: async (presentation) => {
                presentations.push(presentation);
              },
            }),
            { deploymentType: "github.com" },
          ),
      );

      expect(presentations).toEqual([
        {
          url: "https://github.com/login/device?user_code=ABCD",
          userCode: "ABCD",
          instructions: "Enter code ABCD",
        },
      ]);
      expect(result).toEqual({
        fingerprint: "12345",
        suggestedKey: "copilot-12345",
        label: "octocat",
        credentials: {
          githubToken: "github-token",
          copilotToken: "tid=x;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
          expiresAt: 9_999_999_999_000,
          baseURL: "https://api.individual.githubcopilot.com",
        },
        expiresAt: 9_999_999_999_000,
      });
      expect(requestedPaths).toEqual([
        "/login/device/code",
        "/login/oauth/access_token",
        "/copilot_internal/v2/token",
        "/user",
      ]);
      expect(readdirSync(home)).toEqual([]);
    } finally {
      if (previousHome === undefined) delete process.env.AIO_PROXY_HOME;
      else process.env.AIO_PROXY_HOME = previousHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("continues polling after authorization_pending", async () => {
    const progress: string[] = [];

    const result = await withFetchMock(
      deviceFlowFetch({ tokenResponses: [{ error: "authorization_pending" }, { access_token: "github-token" }] }),
      () =>
        loginToGitHubCopilot(loginContext({ progress: (message) => progress.push(message) }), {
          deploymentType: "github.com",
        }),
    );

    expect(result.fingerprint).toBe("12345");
    expect(progress).toContain("Waiting for GitHub authorization");
  });

  test("adds five seconds after slow_down before polling again", async () => {
    jest.useFakeTimers();
    let polls = 0;
    const login = withFetchMock(
      deviceFlowFetch({
        tokenResponses: [{ error: "slow_down" }, { access_token: "github-token" }],
        onTokenPoll: () => polls++,
      }),
      () => loginToGitHubCopilot(loginContext(), { deploymentType: "github.com" }),
    );

    await waitUntil(() => polls === 1);
    await flushMicrotasks();
    expect(polls).toBe(1);
    jest.advanceTimersByTime(4_999);
    await flushMicrotasks();
    expect(polls).toBe(1);
    jest.advanceTimersByTime(1);

    await expect(login).resolves.toMatchObject({ fingerprint: "12345" });
    expect(polls).toBe(2);
  });

  test("surfaces device authorization denial", async () => {
    await withFetchMock(deviceFlowFetch({ tokenResponses: [{ error: "access_denied" }] }), async () => {
      await expect(loginToGitHubCopilot(loginContext(), { deploymentType: "github.com" })).rejects.toThrow(
        "access_denied",
      );
    });
  });

  test("times out when device authorization expires", async () => {
    jest.useFakeTimers();
    let polls = 0;
    const login = withFetchMock(
      deviceFlowFetch({
        expiresIn: 1,
        interval: 5,
        tokenResponses: [{ error: "authorization_pending" }],
        onTokenPoll: () => polls++,
      }),
      () => loginToGitHubCopilot(loginContext(), { deploymentType: "github.com" }),
    );

    await waitUntil(() => polls === 1);
    await flushMicrotasks();
    jest.advanceTimersByTime(5_000);

    await expect(login).rejects.toThrow("GitHub device authorization timed out");
  });

  test("aborts while waiting for the next device poll", async () => {
    const controller = new AbortController();
    let polls = 0;
    const login = withFetchMock(
      deviceFlowFetch({
        interval: 30,
        tokenResponses: [{ error: "authorization_pending" }],
        onTokenPoll: () => polls++,
      }),
      () =>
        loginToGitHubCopilot(loginContext({ signal: controller.signal }), {
          deploymentType: "github.com",
        }),
    );

    await waitUntil(() => polls === 1);
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(login).rejects.toMatchObject({ name: "AbortError" });
    expect(polls).toBe(1);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !predicate(); index++) await Promise.resolve();
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}
