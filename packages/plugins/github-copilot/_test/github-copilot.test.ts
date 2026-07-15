import { afterEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CredentialPort,
  OAuthAdapter,
  OAuthLoginContext,
  PluginDescriptor,
  ProtocolId,
} from "@aio-proxy/plugin-sdk";
import packageJson from "../package.json" with { type: "json" };
import githubCopilotPlugin, {
  COPILOT_CATALOG_TTL_MS,
  createGitHubCopilotPlugin,
  GITHUB_COPILOT_PLUGIN_VERSION,
  type GitHubAccountOptions,
  type GitHubCopilotCredential,
} from "../src";

afterEach(() => {
  jest.useRealTimers();
});

describe("GitHub Copilot plugin", () => {
  test("exports a versioned default descriptor that registers OAuth capability default", async () => {
    const adapter = await adapterFrom(githubCopilotPlugin);

    expect(adapter.id).toBe("default");
    expect(adapter.label).toBe("Login with GitHub Copilot");
    expect(GITHUB_COPILOT_PLUGIN_VERSION).toBe(packageJson.version);
  });

  test("exposes account options for GitHub.com and a conditional Enterprise URL", async () => {
    const adapter = await adapterFrom(githubCopilotPlugin);

    expect(adapter.account.options.form).toEqual([
      {
        type: "select",
        key: "deploymentType",
        label: "Select GitHub deployment type",
        options: [
          { value: "github.com", label: "GitHub.com" },
          { value: "enterprise", label: "GitHub Enterprise" },
        ],
      },
      {
        type: "text",
        key: "enterpriseURL",
        label: "Enter your GitHub Enterprise URL or domain",
        placeholder: "company.ghe.com or https://company.ghe.com",
        when: { key: "deploymentType", equals: "enterprise" },
      },
    ]);
    await expect(adapter.account.options.schema.parseAsync({})).resolves.toEqual({ deploymentType: "github.com" });
    await expect(
      adapter.account.options.schema.parseAsync({
        deploymentType: "enterprise",
        enterpriseURL: " https://company.ghe.com/path ",
      }),
    ).resolves.toEqual({ deploymentType: "enterprise", enterpriseURL: "https://company.ghe.com" });
  });

  test("supports injectable localized account copy", async () => {
    const adapter = await adapterFrom(
      createGitHubCopilotPlugin({
        adapterLabel: "Copilote GitHub",
        deploymentTypeLabel: "Déploiement GitHub",
        githubDotComLabel: "GitHub public",
        enterpriseLabel: "GitHub Entreprise",
        enterpriseURLLabel: "Domaine GitHub Entreprise",
        enterpriseURLPlaceholder: "entreprise.example",
      }),
    );

    expect(adapter.label).toBe("Copilote GitHub");
    expect(adapter.account.options.form[0]?.label).toBe("Déploiement GitHub");
    expect(adapter.account.options.form[1]?.label).toBe("Domaine GitHub Entreprise");
  });

  test("credential parsing omits an absent Enterprise URL", async () => {
    const adapter = await adapterFrom(githubCopilotPlugin);
    const credential = await adapter.credentials.parseAsync({
      githubToken: "github-token",
      copilotToken: "copilot-token",
      expiresAt: 1,
      baseURL: "https://api.githubcopilot.com",
      enterpriseURL: undefined,
    });

    expect("enterpriseURL" in credential).toBe(false);
  });
});

describe("GitHub Copilot login", () => {
  test("rejects an invalid Enterprise domain before fetching", async () => {
    const adapter = await adapterFrom(githubCopilotPlugin);
    let fetched = false;

    await withFetchMock(
      async () => {
        fetched = true;
        return Response.json({});
      },
      async () => {
        await expect(
          adapter.login(loginContext(), {
            deploymentType: "enterprise",
            enterpriseURL: "not a host name",
          }),
        ).rejects.toThrow("GitHub Enterprise URL or domain is required");
      },
    );

    expect(fetched).toBe(false);
  });

  test("presents verification_uri_complete and returns account data without persistence", async () => {
    const adapter = await adapterFrom(githubCopilotPlugin);
    const presentations: unknown[] = [];
    const requestedPaths: string[] = [];
    const previousHome = process.env.AIO_PROXY_HOME;
    const home = mkdtempSync(join(tmpdir(), "aio-proxy-copilot-plugin-"));
    process.env.AIO_PROXY_HOME = home;

    try {
      const result = await withFetchMock(
        fakeCopilotFetch({ onRequest: (url) => requestedPaths.push(url.pathname) }),
        () =>
          adapter.login(
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
    const adapter = await adapterFrom(githubCopilotPlugin);
    const progress: string[] = [];

    const result = await withFetchMock(
      fakeCopilotFetch({ tokenResponses: [{ error: "authorization_pending" }, { access_token: "github-token" }] }),
      () =>
        adapter.login(loginContext({ progress: (message) => progress.push(message) }), {
          deploymentType: "github.com",
        }),
    );

    expect(result.fingerprint).toBe("12345");
    expect(progress).toContain("Waiting for GitHub authorization");
  });

  test("adds five seconds after slow_down before polling again", async () => {
    jest.useFakeTimers();
    const adapter = await adapterFrom(githubCopilotPlugin);
    let polls = 0;
    const login = withFetchMock(
      fakeCopilotFetch({
        tokenResponses: [{ error: "slow_down" }, { access_token: "github-token" }],
        onTokenPoll: () => polls++,
      }),
      () => adapter.login(loginContext(), { deploymentType: "github.com" }),
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
    const adapter = await adapterFrom(githubCopilotPlugin);

    await withFetchMock(fakeCopilotFetch({ tokenResponses: [{ error: "access_denied" }] }), async () => {
      await expect(adapter.login(loginContext(), { deploymentType: "github.com" })).rejects.toThrow("access_denied");
    });
  });

  test("times out when device authorization expires", async () => {
    jest.useFakeTimers();
    const adapter = await adapterFrom(githubCopilotPlugin);
    let polls = 0;
    const login = withFetchMock(
      fakeCopilotFetch({
        expiresIn: 1,
        interval: 5,
        tokenResponses: [{ error: "authorization_pending" }],
        onTokenPoll: () => polls++,
      }),
      () => adapter.login(loginContext(), { deploymentType: "github.com" }),
    );

    await waitUntil(() => polls === 1);
    await flushMicrotasks();
    jest.advanceTimersByTime(5_000);

    await expect(login).rejects.toThrow("GitHub device authorization timed out");
  });

  test("aborts while waiting for the next device poll", async () => {
    const adapter = await adapterFrom(githubCopilotPlugin);
    const controller = new AbortController();
    let polls = 0;
    const login = withFetchMock(
      fakeCopilotFetch({
        interval: 30,
        tokenResponses: [{ error: "authorization_pending" }],
        onTokenPoll: () => polls++,
      }),
      () => adapter.login(loginContext({ signal: controller.signal }), { deploymentType: "github.com" }),
    );

    await waitUntil(() => polls === 1);
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(login).rejects.toMatchObject({ name: "AbortError" });
    expect(polls).toBe(1);
  });
});

describe("GitHub Copilot catalog", () => {
  test("uses a six-hour TTL policy", async () => {
    const adapter = await adapterFrom(githubCopilotPlugin);

    expect(COPILOT_CATALOG_TTL_MS).toBe(6 * 60 * 60_000);
    expect(adapter.catalog.policy).toEqual({ kind: "ttl", ttlMs: 6 * 60 * 60_000 });
  });

  test("refreshes an expired Copilot token and filters hidden or non-chat models", async () => {
    const adapter = await adapterFrom(githubCopilotPlugin);
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

    const catalog = await withFetchMock(
      async (input, init) => {
        const url = new URL(input.toString());
        if (url.pathname === "/copilot_internal/v2/token") {
          refreshSignals.push(init?.signal as AbortSignal);
          return Response.json({
            token: "tid=x;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
            expires_at: 9_999_999_999,
          });
        }
        if (url.pathname === "/models") {
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer tid=x;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
          );
          return modelResponse();
        }
        return Response.json({ error: `unexpected ${url.pathname}` }, { status: 404 });
      },
      () =>
        adapter.catalog.discover({
          credentials: credentials.port,
          options: { deploymentType: "github.com" },
          signal: new AbortController().signal,
        }),
    );

    expect(refreshSignals).toEqual([refreshSignal]);
    expect(credentials.current().value).toMatchObject({
      copilotToken: "tid=x;exp=9999999999;proxy-ep=proxy.individual.githubcopilot.com;",
      baseURL: "https://api.individual.githubcopilot.com",
      expiresAt: 9_999_999_999_000,
    });
    expect(catalog).toEqual({
      language: [
        { id: "gpt-5-mini", displayName: "GPT 5 Mini", metadata: { protocol: "openai-compatible" } },
        { id: "claude-sonnet-4", metadata: { protocol: "anthropic" } },
        { id: "gpt-5", metadata: { protocol: "openai-response" } },
      ],
      image: [],
      embedding: [],
      speech: [],
      transcription: [],
      reranking: [],
    });
  });
});

async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<GitHubAccountOptions, GitHubCopilotCredential>> {
  let registered: OAuthAdapter<GitHubAccountOptions, GitHubCopilotCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(adapter) {
          registered = adapter as OAuthAdapter<GitHubAccountOptions, GitHubCopilotCredential>;
        },
      },
    },
    undefined,
  );
  if (registered === undefined) throw new Error("GitHub Copilot OAuth adapter was not registered");
  return registered;
}

function loginContext(
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

function fakeCopilotFetch(
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
    if (url.pathname === "/user") {
      return Response.json({ id: 12345, login: "octocat" });
    }
    return Response.json({ error: `unexpected ${url.pathname}` }, { status: 404 });
  };
}

function modelResponse(): Response {
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
        capabilities: ["chat"],
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

async function withFetchMock<T>(fetchImpl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !predicate(); index++) await Promise.resolve();
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

const _protocolsCompile: readonly ProtocolId[] = ["openai-compatible", "anthropic", "openai-response"];
void _protocolsCompile;
