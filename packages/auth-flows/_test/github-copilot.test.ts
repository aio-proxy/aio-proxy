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
    let userCode = "";
    const provider = new GitHubCopilotOAuthProvider({
      fetch: fakeCopilotFetch(),
      now: () => 1_000,
      sleep: async () => undefined,
    });

    try {
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

      expect(authUrl).toBe("https://github.com/login/device?user_code=ABCD");
      expect(userCode).toBe("ABCD");
      expect(result.providerId).toBe("copilot-12345");
      expect(result.userId).toBe("12345");
      expect(result.accountLabel).toBe("octocat");
      expect(result.payload.baseUrl).toBe("https://api.individual.githubcopilot.com");
      expect(result.payload.models).toEqual([
        { alias: "gpt-5-mini", id: "gpt-5-mini", transport: "chat" },
        { alias: "claude-sonnet-4", id: "claude-sonnet-4", transport: "messages" },
        { alias: "gpt-5", id: "gpt-5", transport: "responses" },
      ]);
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
    const provider = new GitHubCopilotOAuthProvider({
      fetch: async () => {
        called = true;
        return Response.json({});
      },
      now: () => 1_000,
      sleep: async () => undefined,
    });

    await expect(
      provider.login({ deploymentType: "enterprise", enterpriseUrl: "not a host name" }, { onAuth: () => undefined }),
    ).rejects.toThrow("GitHub Enterprise URL or domain is required");
    expect(called).toBe(false);
  });

  test("token proxy endpoint resolves Copilot API base URL", () => {
    expect(getGitHubCopilotBaseUrl("tid=x;proxy-ep=proxy.individual.githubcopilot.com;")).toBe(
      "https://api.individual.githubcopilot.com",
    );
  });
});

function fakeCopilotFetch(): typeof fetch {
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
      return Response.json({
        data: [
          {
            id: "gpt-5-mini",
            model_picker_enabled: true,
            capabilities: ["chat"],
            endpoints: ["/chat/completions"],
          },
          {
            id: "claude-sonnet-4",
            model_picker_enabled: true,
            capabilities: ["chat"],
            endpoints: ["/v1/messages"],
          },
          {
            id: "gpt-5",
            model_picker_enabled: true,
            capabilities: ["chat"],
            endpoints: ["/responses"],
          },
          {
            id: "hidden",
            model_picker_enabled: false,
            capabilities: ["chat"],
            endpoints: ["/chat/completions"],
          },
          {
            id: "embedding",
            model_picker_enabled: true,
            capabilities: ["embeddings"],
            endpoints: ["/embeddings"],
          },
        ],
      });
    }

    if (url.pathname.startsWith("/models/") && url.pathname.endsWith("/policy")) {
      return Response.json({}, { status: 200 });
    }

    return Response.json({ error: `unexpected ${url.pathname}` }, { status: 404 });
  };
}
