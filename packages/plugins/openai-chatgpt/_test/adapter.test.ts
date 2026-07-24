import {
  type OAuthAdapter,
  type OAuthLoginContext,
  PLUGIN_DESCRIPTOR_BRAND,
  type PluginDescriptor,
} from "@aio-proxy/plugin-sdk";
import { afterEach, describe, expect, test } from "bun:test";

import packageJson from "../package.json" with { type: "json" };
import openAIChatGPTPlugin, { createOpenAIChatGPTPlugin, OPENAI_CHATGPT_PLUGIN_VERSION } from "../src";
import { base64url } from "../src/pkce";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAI ChatGPT plugin", () => {
  test("exports a versioned default descriptor with OAuth capability default", async () => {
    const adapter = await adapterFrom(openAIChatGPTPlugin);

    expect(openAIChatGPTPlugin.apiVersion).toBe(2);
    expect(openAIChatGPTPlugin[PLUGIN_DESCRIPTOR_BRAND]).toBe(true);
    expect(adapter.id).toBe("default");
    expect(adapter.label).toBe("Login with ChatGPT (Plus/Pro)");
    expect(OPENAI_CHATGPT_PLUGIN_VERSION).toBe(packageJson.version);
  });

  test("accepts an empty account options object and exposes no fields", async () => {
    const adapter = await adapterFrom(openAIChatGPTPlugin);

    await expect(adapter.account.options.schema.parseAsync({})).resolves.toEqual({});
    expect(adapter.account.options.form).toEqual([]);
  });

  test("supports injectable localized copy", async () => {
    const adapter = await adapterFrom(createOpenAIChatGPTPlugin({ adapterLabel: "Se connecter avec ChatGPT" }));

    expect(adapter.label).toBe("Se connecter avec ChatGPT");
  });

  test("uses the host loopback redirect URI in authorization and exchange", async () => {
    const adapter = await adapterFrom(openAIChatGPTPlugin);
    const redirectUri = "http://localhost:43123/auth/callback";
    const signal = new AbortController().signal;
    let loopbackRequest: Parameters<OAuthLoginContext["authorization"]["loopback"]>[0] | undefined;
    let exchangedRedirectUri: string | null = null;
    globalThis.fetch = async (_input, init) => {
      const body = new URLSearchParams(String(init?.body));
      exchangedRedirectUri = body.get("redirect_uri");
      expect(init?.signal).toBe(signal);
      return Response.json({
        access_token: buildJwt({ chatgpt_account_id: "account-123" }),
        expires_in: 900,
        refresh_token: "refresh-token",
      });
    };

    const result = await adapter.login(
      loginContext({
        signal,
        loopback: async (request) => {
          loopbackRequest = request;
          const authorizationUrl = new URL(request.authorizationUrl({ redirectUri }));
          expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
          expect(authorizationUrl.searchParams.get("state")).toBe(request.state);
          expect(authorizationUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9\-_]{43}$/);
          return { code: "auth-code", redirectUri };
        },
      }),
      {},
    );

    expect(loopbackRequest).toMatchObject({
      redirect: { hostname: "localhost", port: 1455, path: "/auth/callback" },
      allowManualCallbackUrl: true,
    });
    expect(exchangedRedirectUri).toBe(redirectUri);
    expect(result).toEqual({
      fingerprint: "account-123",
      suggestedKey: "chatgpt-account-123",
      label: "account-123",
      credentials: {
        accessToken: buildJwt({ chatgpt_account_id: "account-123" }),
        accountId: "account-123",
        expiresAt: expect.any(Number),
        refreshToken: "refresh-token",
      },
      expiresAt: expect.any(Number),
    });
  });

  test("uses the Codex language model catalog with a six-hour TTL", async () => {
    const adapter = await adapterFrom(openAIChatGPTPlugin);
    globalThis.fetch = async () =>
      Response.json({
        models: [
          { slug: "gpt-test", display_name: "GPT Test", priority: 1, supported_in_api: true, visibility: "list" },
        ],
      });

    const catalog = await adapter.catalog.discover({
      credentials: unusedCredentialPort(),
      options: {},
      signal: new AbortController().signal,
    });

    expect(catalog).toEqual({
      language: [{ id: "gpt-test", displayName: "GPT Test", metadata: { protocol: "openai-response" } }],
      image: [],
      embedding: [],
      speech: [],
      transcription: [],
      reranking: [],
    });
    expect(adapter.catalog.policy).toEqual({ kind: "ttl", ttlMs: 6 * 60 * 60_000 });
  });
});

async function adapterFrom(descriptor: PluginDescriptor): Promise<OAuthAdapter<Record<string, never>, unknown>> {
  let adapter: OAuthAdapter<Record<string, never>, unknown> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register: (registered) => {
          adapter = registered as OAuthAdapter<Record<string, never>, unknown>;
        },
      },
    },
    undefined,
  );
  if (adapter === undefined) throw new Error("plugin did not register an OAuth adapter");
  return adapter;
}

function loginContext(overrides: {
  readonly loopback: OAuthLoginContext["authorization"]["loopback"];
  readonly signal?: AbortSignal;
}): OAuthLoginContext {
  return {
    authorization: {
      loopback: overrides.loopback,
      presentDeviceCode: async () => undefined,
    },
    progress: () => undefined,
    signal: overrides.signal ?? new AbortController().signal,
  };
}

function unusedCredentialPort() {
  return {
    read: async () => {
      throw new Error("catalog must not read credentials");
    },
    refresh: async () => {
      throw new Error("catalog must not refresh credentials");
    },
  };
}

function buildJwt(payload: Record<string, unknown>): string {
  const header = base64url(new TextEncoder().encode(JSON.stringify({ alg: "none", typ: "JWT" })));
  const body = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  return `${header}.${body}.signature`;
}
