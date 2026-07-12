import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiSdkProviderInstance, ApiProviderInstance } from "@aio-proxy/core";
import { ConfigSchema, OAuthVendor, ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { materializeProviders, materializeRuntimeProvider, providerSummary } from "../src/provider-runtime";
import type { OAuthProviderInstance, RuntimeProviderInstance } from "../src/runtime";
import { createServerState } from "../src/server-state";

test("materializes a configured API provider with raw and bridged model capabilities once", () => {
  const config = ConfigSchema.parse({
    providers: {
      api: {
        baseUrl: "https://api.example.com",
        kind: ProviderKind.Api,
        models: ["model"],
        protocol: ProviderProtocol.OpenAICompatible,
      },
    },
  });
  const bridge = {
    enabled: true,
    id: "api:bridge",
    kind: ProviderKind.AiSdk,
    invoke: () => new ReadableStream(),
  } satisfies AiSdkProviderInstance;
  let bridgeCalls = 0;

  const runtime = materializeProviders(config, {
    bridgeApiProvider(provider) {
      bridgeCalls += 1;
      expect(provider.id).toBe("api");
      return bridge;
    },
  });

  expect(bridgeCalls).toBe(1);
  expect(runtime.providers[0]?.raw?.protocol).toBe(ProviderProtocol.OpenAICompatible);
  expect(runtime.providers[0]?.model?.invoke).toBe(bridge.invoke);
});

test("materializes AI SDK and OAuth inputs with model capabilities only", () => {
  const ensureAvailable = async () => {};
  const invoke = () => new ReadableStream();
  const aiSdk = {
    enabled: true,
    ensureAvailable,
    id: "ai-sdk",
    invoke,
    kind: ProviderKind.AiSdk,
  } satisfies AiSdkProviderInstance;
  const oauth = {
    enabled: true,
    id: "oauth",
    invoke,
    kind: ProviderKind.OAuth,
    vendor: OAuthVendor.GitHubCopilot,
  } satisfies OAuthProviderInstance;

  const aiSdkRuntime = materializeRuntimeProvider(aiSdk);
  const oauthRuntime = materializeRuntimeProvider(oauth);

  expect(aiSdkRuntime.raw).toBeUndefined();
  expect(aiSdkRuntime.model).toEqual({ ensureAvailable, invoke });
  expect(oauthRuntime.raw).toBeUndefined();
  expect(oauthRuntime.model).toEqual({ invoke });
});

test("materializes an injected API test double without baseUrl as raw only", () => {
  const passthrough = async () => new Response();
  const provider = {
    enabled: true,
    id: "api-double",
    kind: ProviderKind.Api,
    passthrough,
    protocol: ProviderProtocol.Anthropic,
  } satisfies Omit<ApiProviderInstance, "baseUrl">;

  const runtime = materializeRuntimeProvider(provider as unknown as ApiProviderInstance);

  expect(runtime.raw).toEqual({ invoke: passthrough, protocol: ProviderProtocol.Anthropic });
  expect(runtime.model).toBeUndefined();
  expect(providerSummary(runtime).passthrough).toBe(true);
});

test("returns an already materialized provider unchanged", () => {
  const invoke = () => new ReadableStream();
  const provider = {
    enabled: true,
    id: "ready",
    invoke,
    kind: ProviderKind.AiSdk,
    model: { invoke },
  } satisfies RuntimeProviderInstance;

  expect(materializeRuntimeProvider(provider)).toBe(provider);
});

test("keeps the model capability reference stable across snapshot reads", () => {
  const dbHome = mkdtempSync(join(tmpdir(), "aio-proxy-provider-capabilities-"));
  const provider = {
    enabled: true,
    id: "stable",
    invoke: () => new ReadableStream(),
    kind: ProviderKind.AiSdk,
  } satisfies AiSdkProviderInstance;
  const state = createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    dbHome,
    providerInstances: [provider],
  });

  try {
    const first = state.currentProviderSnapshot().providers[0]?.model;
    const second = state.currentProviderSnapshot().providers[0]?.model;

    expect(second).toBe(first);
  } finally {
    state.close();
    rmSync(dbHome, { force: true, recursive: true });
  }
});
