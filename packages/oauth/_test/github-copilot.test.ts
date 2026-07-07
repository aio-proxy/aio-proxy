import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth } from "../src";
import { GitHubCopilotOAuthProvider, getGitHubCopilotBaseUrl } from "../src/github-copilot";

const homes: string[] = [];

afterEach(() => {
  const previousHome = homes.pop();
  if (previousHome === undefined) {
    delete process.env.AIO_PROXY_HOME;
  } else {
    process.env.AIO_PROXY_HOME = previousHome;
  }
});

function isolateHome() {
  const previousHome = process.env.AIO_PROXY_HOME;
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-copilot-auth-"));
  process.env.AIO_PROXY_HOME = home;
  homes.push(previousHome);
  return home;
}

describe("GitHubCopilotOAuthProvider", () => {
  test("login creates provider id from GitHub numeric user id", async () => {
    const home = isolateHome();
    let authUrl = "";
    let modelRequests = 0;
    let userCode = "";
    const provider = new GitHubCopilotOAuthProvider();

    try {
      const { models, result } = await withFetchMock(
        fakeCopilotFetch(() => modelRequests++),
        async () => {
          const result = await provider.login(
            {},
            {
              onAuth: (info) => {
                authUrl = info.url;
                userCode = info.userCode ?? "";
              },
              onProgress: () => undefined,
            },
          );
          expect(modelRequests).toBe(0);
          return { models: await provider.models(result.payload), result };
        },
      );

      expect(authUrl).toBe("https://github.com/login/device?user_code=ABCD");
      expect(userCode).toBe("ABCD");
      expect(result.providerId).toBe("copilot-12345");
      expect(result.userId).toBe("12345");
      expect(result.accountLabel).toBe("octocat");
      expect(result.payload.baseUrl).toBe("https://api.individual.githubcopilot.com");
      expect("models" in result.payload).toBe(false);
      expect("models" in result).toBe(false);
      expect(models).toEqual([
        { id: "gpt-5-mini", displayName: "GPT 5 Mini", transport: "chat" },
        { id: "claude-sonnet-4", transport: "messages" },
        { id: "gpt-5", transport: "responses" },
      ]);
      expect(modelRequests).toBe(1);
      expect(Auth.get("github-copilot", "copilot-12345")?.payload).toEqual({
        ...result.payload,
        accountLabel: "octocat",
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("exposes reusable login form prompts", () => {
    const provider = new GitHubCopilotOAuthProvider();

    expect(provider.loginForm).toEqual({
      type: "oauth",
      label: "Login with GitHub Copilot",
      prompts: [
        {
          type: "select",
          key: "deploymentType",
          message: "Select GitHub deployment type",
          options: [
            { label: "GitHub.com", value: "github.com", hint: "Public" },
            { label: "GitHub Enterprise", value: "enterprise", hint: "Data residency or self-hosted" },
          ],
        },
        {
          type: "text",
          key: "enterpriseUrl",
          message: "Enter your GitHub Enterprise URL or domain",
          placeholder: "company.ghe.com or https://company.ghe.com",
          when: { key: "deploymentType", op: "eq", value: "enterprise" },
          validate: { required: true, format: "domain-or-url" },
        },
      ],
    });
  });

  test("enterprise login validates domain before device flow", async () => {
    let called = false;
    const provider = new GitHubCopilotOAuthProvider();
    await withFetchMock(
      async () => {
        called = true;
        return Response.json({});
      },
      async () => {
        await expect(
          provider.login(
            { deploymentType: "enterprise", enterpriseUrl: "not a host name" },
            { onAuth: () => undefined },
          ),
        ).rejects.toThrow("GitHub Enterprise URL or domain is required");
      },
    );
    expect(called).toBe(false);
  });

  test("token proxy endpoint resolves Copilot API base URL", () => {
    expect(getGitHubCopilotBaseUrl("tid=x;proxy-ep=proxy.individual.githubcopilot.com;")).toBe(
      "https://api.individual.githubcopilot.com",
    );
  });

  test("models refreshes Copilot access before discovery", async () => {
    const provider = new GitHubCopilotOAuthProvider();

    const models = await withFetchMock(
      async (input, init) => {
        const url = new URL(input.toString());
        if (url.pathname === "/copilot_internal/v2/token") {
          return Response.json({
            token: "tid=x;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
            expires_at: 9_999_999_999,
          });
        }
        if (
          url.pathname === "/models" &&
          new Headers(init?.headers).get("authorization")?.includes("tid=x;") === true
        ) {
          return Response.json({
            data: [
              {
                id: "gpt-5-mini",
                model_picker_enabled: true,
                capabilities: { type: "chat" },
                supported_endpoints: ["/chat/completions"],
              },
            ],
          });
        }
        return Response.json({}, { status: 401 });
      },
      () =>
        provider.models({
          access: "stale-token",
          refresh: "github-token",
          expires: Date.now() + 60_000,
          baseUrl: "https://api.individual.githubcopilot.com",
        }),
    );

    expect(models).toEqual([{ id: "gpt-5-mini", transport: "chat" }]);
  });
});

function fakeCopilotFetch(onModels: () => void = () => undefined): typeof fetch {
  return async (input) => {
    const url = new URL(input.toString());
    if (url.pathname === "/login/device/code") {
      return Response.json({
        device_code: "device",
        user_code: "ABCD",
        verification_uri: "https://github.com/login/device",
        verification_uri_complete: "https://github.com/login/device?user_code=ABCD",
        interval: 0,
        expires_in: 600,
      });
    }

    if (url.pathname === "/login/oauth/access_token") {
      return Response.json({ access_token: "github-token" });
    }

    if (url.pathname === "/copilot_internal/v2/token") {
      return Response.json({
        token: "tid=x;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
        expires_at: 9_999_999_999,
      });
    }

    if (url.pathname === "/user") {
      return Response.json({ id: 12345, login: "octocat", email: null });
    }

    if (url.pathname === "/models") {
      onModels();
      return Response.json({
        data: [
          {
            id: "gpt-5-mini",
            name: "GPT 5 Mini",
            model_picker_enabled: true,
            capabilities: { type: "chat" },
            supported_endpoints: ["/chat/completions"],
          },
          {
            id: "claude-sonnet-4",
            model_picker_enabled: true,
            capabilities: { type: "chat" },
            supported_endpoints: ["/v1/messages"],
          },
          {
            id: "gpt-5",
            model_picker_enabled: true,
            capabilities: { type: "chat" },
            supported_endpoints: ["/responses"],
          },
          {
            id: "hidden",
            model_picker_enabled: false,
            capabilities: { type: "chat" },
            supported_endpoints: ["/chat/completions"],
          },
          {
            id: "embedding",
            model_picker_enabled: true,
            capabilities: { type: "embeddings" },
            supported_endpoints: ["/embeddings"],
          },
        ],
      });
    }

    if (url.pathname.startsWith("/models/") && url.pathname.endsWith("/policy")) {
      return Response.json({}, { status: 405 });
    }

    return Response.json({ error: `unexpected ${url.pathname}` }, { status: 404 });
  };
}

async function withFetchMock<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
