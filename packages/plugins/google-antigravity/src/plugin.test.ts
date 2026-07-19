import { expect, test } from "bun:test";
import type { LoopbackRequest, OAuthAdapter, PluginDescriptor } from "@aio-proxy/plugin-sdk";
import packageJson from "../package.json" with { type: "json" };
import googleAntigravityPlugin, { createGoogleAntigravityPlugin, GOOGLE_ANTIGRAVITY_PLUGIN_VERSION } from ".";
import type { GoogleAntigravityAccountOptions, GoogleAntigravityCredential } from "./schema";

test("exports a versioned default descriptor", async () => {
  const adapter = await adapterFrom(googleAntigravityPlugin);
  expect(adapter.id).toBe("default");
  expect(adapter.label).toBe("Login with Google Antigravity");
  expect(GOOGLE_ANTIGRAVITY_PLUGIN_VERSION).toBe(packageJson.version);
});

test("uses the fixed loopback callback and returns a complete stable account identity", async () => {
  let loopbackRequest: LoopbackRequest | undefined;
  const requests: Request[] = [];
  const adapter = await adapterFrom(
    createGoogleAntigravityPlugin(undefined, {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.includes("oauth2.googleapis.com/token")) {
          return Response.json({
            access_token: "access-1",
            refresh_token: "refresh-1",
            expires_in: 3600,
            token_type: "Bearer",
          });
        }
        if (request.url.includes("oauth2/v2/userinfo")) return Response.json({ email: "person@example.com" });
        return Response.json({ cloudaicompanionProject: "project-1" });
      },
      now: () => 1_700_000_000_000,
      sleep: async () => {},
    }),
  );

  const result = await adapter.login(
    {
      authorization: {
        presentDeviceCode: async () => {},
        loopback: async (input) => {
          loopbackRequest = input;
          const authorizationUrl = new URL(
            input.authorizationUrl({ redirectUri: "http://localhost:51121/oauth-callback" }),
          );
          expect(authorizationUrl.searchParams.get("state")).toBe(input.state);
          return { code: "authorization-code", redirectUri: "http://localhost:51121/oauth-callback" };
        },
      },
      progress: () => {},
      signal: new AbortController().signal,
    },
    {},
  );

  expect(loopbackRequest?.redirect).toEqual({ hostname: "localhost", port: 51121, path: "/oauth-callback" });
  expect(loopbackRequest?.allowManualCallbackUrl).toBe(true);
  expect(result).toEqual({
    fingerprint: "person@example.com",
    suggestedKey: "antigravity-person@example.com",
    label: "person@example.com",
    credentials: {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: 1_700_003_600_000,
      tokenType: "Bearer",
      email: "person@example.com",
      projectId: "project-1",
    },
    expiresAt: 1_700_003_600_000,
  });
  expect(requests).toHaveLength(3);
});

test("rejects missing callback code before token exchange", async () => {
  let fetched = false;
  const adapter = await adapterFrom(
    createGoogleAntigravityPlugin(undefined, {
      fetch: async () => {
        fetched = true;
        return Response.json({});
      },
    }),
  );
  await expect(
    adapter.login(
      loginContext(async () => ({ code: " ", redirectUri: "http://localhost/cb" })),
      {},
    ),
  ).rejects.toThrow("authorization code");
  expect(fetched).toBe(false);
});

test("rejects token exchange without a refresh token", async () => {
  const adapter = await adapterFrom(
    createGoogleAntigravityPlugin(undefined, {
      fetch: async () => Response.json({ access_token: "access-1", expires_in: 3600 }),
    }),
  );
  await expect(adapter.login(loginContext(), {})).rejects.toThrow("refresh token");
});

test("rejects userinfo without an email", async () => {
  let requests = 0;
  const adapter = await adapterFrom(
    createGoogleAntigravityPlugin(undefined, {
      fetch: async () => {
        requests += 1;
        return requests === 1
          ? Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 })
          : Response.json({});
      },
    }),
  );
  await expect(adapter.login(loginContext(), {})).rejects.toThrow("email");
});

test("propagates state mismatch reported by the authorization port", async () => {
  const adapter = await adapterFrom(createGoogleAntigravityPlugin());
  const mismatch = new Error("OAuth state mismatch");
  await expect(
    adapter.login(
      loginContext(async () => {
        throw mismatch;
      }),
      {},
    ),
  ).rejects.toBe(mismatch);
});

test("rejects project initialization exhaustion after five polls", async () => {
  let requests = 0;
  const adapter = await adapterFrom(
    createGoogleAntigravityPlugin(undefined, {
      fetch: async () => {
        requests += 1;
        if (requests === 1) {
          return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
        }
        if (requests === 2) return Response.json({ email: "person@example.com" });
        if (requests === 3) return Response.json({});
        return Response.json({ done: false });
      },
      sleep: async () => {},
    }),
  );
  await expect(adapter.login(loginContext(), {})).rejects.toThrow("five attempts");
  expect(requests).toBe(8);
});

test("runtime exposes Google ProviderV4, Gemini raw, and token-count capabilities", async () => {
  const adapter = await adapterFrom(createGoogleAntigravityPlugin());
  const runtime = await adapter.createRuntime({
    credentials: memoryPort(),
    options: {},
    catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
  });
  expect(runtime.provider.specificationVersion).toBe("v4");
  expect(runtime.provider.languageModel("gemini-3-flash-agent").modelId).toBe("gemini-3-flash-agent");
  expect(runtime.raw?.({ protocol: "gemini", modelId: "gemini-3-flash-agent" })).toBeDefined();
  expect(runtime.tokenCount).toBeDefined();
  expect(() => runtime.provider.embeddingModel("model")).toThrow("does not support embedding");
  expect(() => runtime.provider.imageModel("model")).toThrow("does not support image generation");
});

function loginContext(
  loopback: (
    input: LoopbackRequest,
  ) => Promise<{ readonly code: string; readonly redirectUri: string }> = async () => ({
    code: "authorization-code",
    redirectUri: "http://localhost:51121/oauth-callback",
  }),
) {
  return {
    authorization: { presentDeviceCode: async () => {}, loopback },
    progress: () => {},
    signal: new AbortController().signal,
  };
}

function memoryPort() {
  const credential: GoogleAntigravityCredential = {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: 1,
    email: "person@example.com",
    projectId: "project",
  };
  return {
    read: async () => ({ value: credential, revision: 1 }),
    refresh: async () => ({ status: "superseded" as const, snapshot: { value: credential, revision: 1 } }),
  };
}

async function adapterFrom(
  descriptor: PluginDescriptor<undefined>,
): Promise<OAuthAdapter<GoogleAntigravityAccountOptions, GoogleAntigravityCredential>> {
  let registered: OAuthAdapter<GoogleAntigravityAccountOptions, GoogleAntigravityCredential> | undefined;
  await descriptor.setup(
    {
      oauth: {
        register(adapter) {
          registered = adapter as OAuthAdapter<GoogleAntigravityAccountOptions, GoogleAntigravityCredential>;
        },
      },
    },
    undefined,
  );
  if (registered === undefined) throw new Error("Google Antigravity OAuth adapter was not registered");
  return registered;
}
