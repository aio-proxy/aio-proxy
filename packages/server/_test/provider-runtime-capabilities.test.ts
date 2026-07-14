import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiSdkProviderInstance, ApiProviderInstance } from "@aio-proxy/core";
import { ConfigSchema, OAuthVendor, ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { materializeProviders, materializeRuntimeProvider } from "../src/provider-runtime";
import type { OAuthProviderInstance, RuntimeProviderInstance } from "../src/runtime";
import { createServerState } from "../src/server-state";

function assertRuntimeProviderRequiresCapability(provider: AiSdkProviderInstance): void {
  // @ts-expect-error a materialized runtime provider must expose raw or model
  const runtime: RuntimeProviderInstance = provider;
  void runtime;
}
void assertRuntimeProviderRequiresCapability;

test("materializes a configured API provider with raw and bridged model capabilities once", () => {
  const config = ConfigSchema.parse({
    providers: {
      api: {
        baseURL: "https://api.example.com",
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

test("materializes an API input whose raw placeholder is undefined", () => {
  const passthrough = async () => new Response();
  const provider = {
    baseURL: "https://api.example.com",
    enabled: true,
    id: "api-placeholder",
    kind: ProviderKind.Api,
    passthrough,
    protocol: ProviderProtocol.Anthropic,
    raw: undefined,
  } satisfies ApiProviderInstance & { readonly raw: undefined };

  const runtime = materializeRuntimeProvider(provider);

  expect(runtime).not.toBe(provider);
  expect(runtime.raw).toEqual({ invoke: passthrough, protocol: ProviderProtocol.Anthropic });
  expect(runtime.model).toBeUndefined();
});

test("materializes an AI SDK input whose model placeholder is undefined", () => {
  const invoke = () => new ReadableStream();
  const provider = {
    enabled: true,
    id: "model-placeholder",
    invoke,
    kind: ProviderKind.AiSdk,
    model: undefined,
  } satisfies AiSdkProviderInstance & { readonly model: undefined };

  const runtime = materializeRuntimeProvider(provider);

  expect(runtime).not.toBe(provider);
  expect(runtime.raw).toBeUndefined();
  expect(runtime.model).toEqual({ invoke });
});

test("materializes an AI SDK input instead of accepting an inherited model capability", () => {
  const invoke = () => new ReadableStream();
  const inheritedModel = { invoke };
  const provider = Object.assign(Object.create({ model: inheritedModel }) as AiSdkProviderInstance, {
    enabled: true,
    id: "inherited-model",
    invoke,
    kind: ProviderKind.AiSdk,
  });

  const runtime = materializeRuntimeProvider(provider);

  expect(runtime).not.toBe(provider);
  expect(runtime.model).not.toBe(inheritedModel);
  expect(runtime.model?.invoke).toBe(invoke);
});

test("materializes an injected API test double without baseURL through the snapshot seam", () => {
  const passthrough = async () => new Response();
  const provider = {
    enabled: true,
    id: "api-double",
    kind: ProviderKind.Api,
    passthrough,
    protocol: ProviderProtocol.Anthropic,
  } satisfies Omit<ApiProviderInstance, "baseURL">;
  const dbHome = mkdtempSync(join(tmpdir(), "aio-proxy-provider-capabilities-"));
  const state = createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    dbHome,
    providerInstances: [provider as unknown as ApiProviderInstance],
  });

  try {
    const runtime = state.currentProviderSnapshot().providers[0];

    expect(runtime?.raw).toEqual({ invoke: passthrough, protocol: ProviderProtocol.Anthropic });
    expect(runtime?.model).toBeUndefined();
  } finally {
    state.close();
    rmSync(dbHome, { force: true, recursive: true });
  }
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

test("replaces the model capability object only after config reload", async () => {
  const dbHome = mkdtempSync(join(tmpdir(), "aio-proxy-provider-capabilities-"));
  const configPath = join(dbHome, "config.json");
  const config = ConfigSchema.parse({
    providers: {
      api: {
        baseURL: "https://before.example.com",
        kind: ProviderKind.Api,
        models: ["model"],
        protocol: ProviderProtocol.OpenAICompatible,
      },
    },
  });
  writeFileSync(configPath, JSON.stringify(config));
  const state = createServerState({ config, configPath, dbHome, watchConfig: false });

  try {
    const before = state.currentProviderSnapshot().providers[0]?.model;
    expect(state.currentProviderSnapshot().providers[0]?.model).toBe(before);

    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          api: {
            baseURL: "https://after.example.com",
            kind: ProviderKind.Api,
            models: ["model"],
            protocol: ProviderProtocol.OpenAICompatible,
          },
        },
      }),
    );
    expect((await state.reload()).ok).toBe(true);

    expect(state.currentProviderSnapshot().providers[0]?.model).not.toBe(before);
  } finally {
    state.close();
    rmSync(dbHome, { force: true, recursive: true });
  }
});

test("does not materialize configured providers before building an injected snapshot", () => {
  const config = ConfigSchema.parse({
    providers: {
      configured: {
        baseURL: "https://configured.example.com",
        kind: ProviderKind.Api,
        models: ["configured-model"],
        protocol: ProviderProtocol.OpenAICompatible,
      },
    },
  });
  const configured = config.providers[0];
  if (configured === undefined) {
    throw new Error("configured provider is missing");
  }
  let baseURLReads = 0;
  Object.defineProperty(configured, "baseURL", {
    configurable: true,
    enumerable: true,
    get() {
      baseURLReads += 1;
      return "https://configured.example.com";
    },
  });
  const provider = {
    enabled: true,
    id: "injected",
    invoke: () => new ReadableStream(),
    kind: ProviderKind.AiSdk,
  } satisfies AiSdkProviderInstance;
  const dbHome = mkdtempSync(join(tmpdir(), "aio-proxy-provider-capabilities-"));
  const state = createServerState({ config, dbHome, providerInstances: [provider] });

  try {
    expect(baseURLReads).toBe(0);
    expect(state.currentProviderSnapshot().providers.map((entry) => entry.id)).toEqual(["injected"]);
  } finally {
    state.close();
    rmSync(dbHome, { force: true, recursive: true });
  }
});
