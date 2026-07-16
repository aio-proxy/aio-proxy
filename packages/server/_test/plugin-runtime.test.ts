import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPluginRegistryHost,
  createPluginRepository,
  type DiagnosticFactory,
  loadPluginRegistry,
  type PluginRepository,
  Router,
} from "@aio-proxy/core";
import { type OpenDbHandle, openDb } from "@aio-proxy/core/db";
import { definePlugin, type ModelCatalog, type OAuthAdapter, zod } from "@aio-proxy/plugin-sdk";
import { ConfigSchema, ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import {
  type MaterializePluginProviderOptions,
  materializePluginProvider as materializePluginProviderWithDigest,
  PluginRawResolverError,
  PluginRawTransportError,
  pluginOptionsIdentityDigest,
  validatePluginProtocolMap,
} from "../src/plugin-runtime";
import { createServerState } from "../src/server-state";

const homes: string[] = [];
const handles: OpenDbHandle[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const catalog: ModelCatalog = {
  language: [{ id: "model" }],
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
};

const diagnostics: DiagnosticFactory = (code, options) => ({
  code,
  summary: code,
  retryable: options.retryable,
  occurredAt: new Date(0).toISOString(),
  ...(options.suggestedCommand === undefined ? {} : { suggestedCommand: options.suggestedCommand }),
});

const emptyPluginOptionsDigest = pluginOptionsIdentityDigest({ public: undefined, secret: undefined });

function materializePluginProvider(
  options: Omit<MaterializePluginProviderOptions, "pluginOptionsDigest"> & {
    readonly pluginOptionsDigest?: MaterializePluginProviderOptions["pluginOptionsDigest"];
  },
) {
  return materializePluginProviderWithDigest({ pluginOptionsDigest: emptyPluginOptionsDigest, ...options });
}

function runtimeFixture(
  policy: OAuthAdapter["catalog"]["policy"],
  overrides: {
    readonly accountOptionsSchema?: OAuthAdapter["account"]["options"]["schema"];
    readonly catalog?: ModelCatalog | null;
    readonly createRuntime?: OAuthAdapter["createRuntime"];
    readonly providerId?: string;
  } = {},
): {
  readonly repository: PluginRepository;
  readonly plugins: Parameters<typeof materializePluginProvider>[0]["plugins"];
  readonly createCalls: () => number;
} {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-runtime-"));
  homes.push(home);
  const handle = openDb({ home });
  handles.push(handle);
  const repository = createPluginRepository(handle.sqlite);
  const fixtureCatalog = overrides.catalog === undefined ? catalog : overrides.catalog;
  const providerId = overrides.providerId ?? "person";
  const operation = repository.stageAccountOperation({
    kind: "create",
    targetDigest: "create",
    account: {
      providerId,
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: `${providerId}@example.com`,
      options: {},
      secrets: {},
      credential: { token: "secret" },
      catalog:
        fixtureCatalog === null
          ? {
              kind: "missing",
              diagnostic: diagnostics("CATALOG_UNAVAILABLE", { providerId, retryable: true }),
            }
          : { kind: "replace", value: { catalog: fixtureCatalog, refreshedAt: 1_000 } },
    },
  });
  repository.completeAccountOperation(operation.operationId);

  const host = createPluginRegistryHost();
  let calls = 0;
  const staging = host.stage("@example/oauth");
  staging.api.oauth.register({
    id: "default",
    label: "Example",
    account: { options: { schema: overrides.accountOptionsSchema ?? zod.object({}), form: [] } },
    credentials: zod.object({ token: zod.string() }),
    async login() {
      throw new Error("not called");
    },
    catalog: {
      policy,
      async discover() {
        return fixtureCatalog ?? catalog;
      },
    },
    async createRuntime(context) {
      calls++;
      if (overrides.createRuntime !== undefined) return overrides.createRuntime(context as never);
      return {
        provider: {
          specificationVersion: "v4",
          languageModel() {
            throw new Error("not called");
          },
          imageModel() {
            throw new Error("not called");
          },
          embeddingModel() {
            throw new Error("not called");
          },
        },
      } as never;
    },
  });
  staging.seal();
  staging.commit();
  return {
    repository,
    createCalls: () => calls,
    plugins: {
      registry: host.registry,
      plugins: new Map([
        [
          "@example/oauth",
          { packageName: "@example/oauth", version: "1.0.0", builtIn: false, state: { status: "ready" } },
        ],
      ]),
    },
  };
}

test("maps every internal provider protocol to the plugin SDK protocol", () => {
  expect(validatePluginProtocolMap()).toEqual({
    [ProviderProtocol.OpenAICompatible]: "openai-compatible",
    [ProviderProtocol.OpenAIResponse]: "openai-response",
    [ProviderProtocol.Anthropic]: "anthropic",
    [ProviderProtocol.Gemini]: "gemini",
  });
});

test("a missing plugin degrades only its structured OAuth provider", async () => {
  const result = await materializePluginProvider({
    config: {
      id: "person",
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: "@example/missing",
      capability: "default",
    },
    plugins: {
      plugins: new Map(),
      registry: { resolveOAuth: () => undefined, oauthCapabilities: () => [] },
    },
    repository: {} as never,
    diagnostics: (code, options) => ({
      code,
      summary: `${code}:${options.providerId ?? ""}`,
      retryable: options.retryable,
      occurredAt: new Date(0).toISOString(),
    }),
    logger: () => {},
    onDiagnosticChanged: () => {},
  });

  expect(result.provider).toBeUndefined();
  expect(result.state).toMatchObject({ status: "unavailable", diagnostic: { code: "PLUGIN_NOT_INSTALLED" } });
  expect(result.summary).toMatchObject({ id: "person", enabled: true, clientModels: [] });
});

test("an expired TTL catalog is ready but stale before a refresh diagnostic exists", async () => {
  const fixture = runtimeFixture({ kind: "ttl", ttlMs: 1 });

  const result = await materializePluginProvider({
    config: {
      id: "person",
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: "@example/oauth",
      capability: "default",
    },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  });

  expect(result.provider?.id).toBe("person");
  expect(result.state).toEqual({ status: "ready", catalog: "stale" });
});

test("the provider config key becomes the materialized runtime provider ID", async () => {
  const fixture = runtimeFixture({ kind: "static" }, { providerId: "configured-key" });
  const serverHome = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-runtime-server-"));
  homes.push(serverHome);
  const descriptor = definePlugin((api) => {
    api.oauth.register({
      id: "default",
      label: "Example",
      account: { options: { schema: zod.object({}), form: [] } },
      credentials: zod.object({ token: zod.string() }),
      async login() {
        throw new Error("not called");
      },
      catalog: {
        policy: { kind: "static" },
        async discover() {
          throw new Error("stored catalog should be used");
        },
      },
      async createRuntime() {
        return {
          provider: {
            specificationVersion: "v4",
            languageModel() {
              throw new Error("not called");
            },
            imageModel() {
              throw new Error("not called");
            },
            embeddingModel() {
              throw new Error("not called");
            },
          },
        } as never;
      },
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse({
      providers: {
        "configured-key": {
          kind: "oauth",
          plugin: "@example/oauth",
          capability: "default",
        },
      },
    }),
    dbHome: serverHome,
    pluginRepository: fixture.repository,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor }],
    pluginLogger: () => {},
  });

  try {
    const snapshot = state.currentProviderSnapshot();
    expect(snapshot.providers[0]?.id).toBe("configured-key");
    expect(snapshot.providerStates?.get("configured-key")).toEqual({ status: "ready", catalog: "fresh" });
    expect(snapshot.providerStates?.has("person")).toBe(false);
    expect(snapshot.router.resolve("model")[0]?.provider.id).toBe("configured-key");
  } finally {
    state.close();
  }
});

test("a materialized OAuth provider obeys real Router self, rename, and preserve aliases", async () => {
  const fixture = runtimeFixture({ kind: "static" });
  const base = {
    id: "person",
    kind: ProviderKind.OAuth,
    enabled: true,
    plugin: "@example/oauth",
    capability: "default",
  } as const;
  const options = {
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  };
  const direct = await materializePluginProvider({ ...options, config: base });
  const renamed = await materializePluginProvider({
    ...options,
    config: { ...base, alias: { renamed: { model: "model", preserve: false } } },
    previous: direct.cacheEntry,
  });
  const preserved = await materializePluginProvider({
    ...options,
    config: { ...base, alias: { kept: { model: "model", preserve: true } } },
    previous: renamed.cacheEntry,
  });
  if (direct.provider === undefined || renamed.provider === undefined || preserved.provider === undefined) {
    throw new Error("runtime fixture did not materialize providers");
  }
  const directRouter = new Router([direct.provider]);
  const renamedRouter = new Router([renamed.provider]);
  const preservedRouter = new Router([preserved.provider]);

  expect(directRouter.resolve("model")[0]?.modelId).toBe("model");
  expect(renamedRouter.resolve("renamed")[0]?.modelId).toBe("model");
  expect(() => renamedRouter.resolve("model")).toThrow();
  expect(preservedRouter.resolve("kept")[0]?.modelId).toBe("model");
  expect(preservedRouter.resolve("model")[0]?.modelId).toBe("model");
});

test("a malformed stored catalog becomes unavailable and schedules safe rediscovery", async () => {
  const fixture = runtimeFixture({ kind: "static" });
  fixture.repository.writeCatalog("person", { language: "invalid" } as never, 1_000);

  const result = await materializePluginProvider({
    config: {
      id: "person",
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: "@example/oauth",
      capability: "default",
    },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  });

  expect(result.provider).toBeUndefined();
  expect(result.state).toMatchObject({ status: "unavailable", diagnostic: { code: "CATALOG_UNAVAILABLE" } });
  expect(result.catalogJob).toBeDefined();
});

test("an initially disabled provider validates state without creating runtime or catalog work", async () => {
  const fixture = runtimeFixture({ kind: "ttl", ttlMs: 1 });

  const result = await materializePluginProvider({
    config: {
      id: "person",
      kind: ProviderKind.OAuth,
      enabled: false,
      plugin: "@example/oauth",
      capability: "default",
    },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  });

  expect(fixture.createCalls()).toBe(0);
  expect(result.provider).toBeUndefined();
  expect(result.catalogJob).toBeUndefined();
  expect(result.state).toMatchObject({ status: "ready", catalog: "stale" });
});

test("disabling and re-enabling reuses the runtime while updating enabled and aliases", async () => {
  const fixture = runtimeFixture({ kind: "static" });
  const base = {
    id: "person",
    kind: ProviderKind.OAuth,
    plugin: "@example/oauth",
    capability: "default",
  } as const;
  const options = {
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  };

  const enabled = await materializePluginProvider({ ...options, config: { ...base, enabled: true } });
  const disabled = await materializePluginProvider({
    ...options,
    config: { ...base, enabled: false, alias: { client: { model: "model" } } },
    previous: enabled.cacheEntry,
  });
  const reenabled = await materializePluginProvider({
    ...options,
    config: { ...base, enabled: true, alias: { client: { model: "model" } } },
    previous: disabled.cacheEntry,
  });

  expect(fixture.createCalls()).toBe(1);
  expect(disabled.provider).toBeUndefined();
  expect(disabled.cacheEntry?.provider).toMatchObject({ enabled: false, alias: { client: { model: "model" } } });
  expect(reenabled.provider).toMatchObject({ enabled: true, alias: { client: { model: "model" } } });
});

test("an identity change creates a new credential port with the new plugin generation", async () => {
  const fixture = runtimeFixture({ kind: "static" });
  const options = {
    config: {
      id: "person",
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: "@example/oauth",
      capability: "default",
    },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  } as const;
  const first = await materializePluginProvider(options);
  const nextPlugins = {
    ...fixture.plugins,
    plugins: new Map([
      [
        "@example/oauth",
        { packageName: "@example/oauth", version: "2.0.0", builtIn: false, state: { status: "ready" as const } },
      ],
    ]),
  };
  const second = await materializePluginProvider({ ...options, plugins: nextPlugins, previous: first.cacheEntry });

  expect(fixture.createCalls()).toBe(2);
  expect(second.cacheEntry?.credentials).not.toBe(first.cacheEntry?.credentials);
});

test("plugin options, account re-login revision, and catalog refresh each rebuild the affected runtime", async () => {
  const fixture = runtimeFixture({ kind: "static" });
  const base = {
    config: {
      id: "person",
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: "@example/oauth",
      capability: "default",
    },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  } as const;
  const first = await materializePluginProvider({
    ...base,
    pluginOptionsDigest: pluginOptionsIdentityDigest({ public: { mode: "one" }, secret: undefined }),
  });
  const pluginOptionsChanged = await materializePluginProvider({
    ...base,
    pluginOptionsDigest: pluginOptionsIdentityDigest({ public: { mode: "two" }, secret: undefined }),
    previous: first.cacheEntry,
  });
  const account = fixture.repository.readAccount("person");
  expect(account).not.toBeNull();
  const relogin = fixture.repository.stageAccountOperation({
    kind: "update",
    targetDigest: "relogin",
    expectedRuntimeRevision: account?.runtimeRevision ?? -1,
    account: {
      providerId: "person",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "person@example.com",
      options: {},
      secrets: {},
      credential: { token: "relogin-secret" },
      catalog: {
        kind: "replace",
        value: { catalog, refreshedAt: 1_000 },
      },
    },
  });
  fixture.repository.completeAccountOperation(relogin.operationId);
  const relogged = await materializePluginProvider({
    ...base,
    pluginOptionsDigest: pluginOptionsIdentityDigest({ public: { mode: "two" }, secret: undefined }),
    previous: pluginOptionsChanged.cacheEntry,
  });
  fixture.repository.writeCatalog("person", catalog, 2_000);
  const refreshed = await materializePluginProvider({
    ...base,
    pluginOptionsDigest: pluginOptionsIdentityDigest({ public: { mode: "two" }, secret: undefined }),
    previous: relogged.cacheEntry,
  });

  expect(fixture.createCalls()).toBe(4);
  expect(pluginOptionsChanged.cacheEntry?.identity).not.toBe(first.cacheEntry?.identity);
  expect(relogged.cacheEntry?.identity).not.toBe(pluginOptionsChanged.cacheEntry?.identity);
  expect(refreshed.cacheEntry?.identity).not.toBe(relogged.cacheEntry?.identity);
});

test.each([
  ["URL", URL, (value: string) => new URL(value), "https://one.example.test", "https://two.example.test"],
  ["Date", Date, (value: string) => new Date(value), "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z"],
] as const)("%s account-option transforms reuse unchanged JSON inputs and rebuild changed inputs", async (_label, transformedType, transform, firstValue, secondValue) => {
  const observed: unknown[] = [];
  const fixture = runtimeFixture(
    { kind: "static" },
    {
      accountOptionsSchema: zod.object({ value: zod.string() }).transform(({ value }) => ({ value: transform(value) })),
      createRuntime: async ({ options }) => {
        observed.push(options);
        return {
          provider: {
            specificationVersion: "v4",
            languageModel() {
              throw new Error("not called");
            },
            imageModel() {
              throw new Error("not called");
            },
            embeddingModel() {
              throw new Error("not called");
            },
          },
        } as never;
      },
    },
  );
  const base = {
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  } as const;
  const config = {
    id: "person",
    kind: ProviderKind.OAuth,
    enabled: true,
    plugin: "@example/oauth",
    capability: "default",
    options: { value: firstValue },
  } as const;

  const first = await materializePluginProvider({ ...base, config });
  const unchanged = await materializePluginProvider({ ...base, config, previous: first.cacheEntry });
  const changed = await materializePluginProvider({
    ...base,
    config: { ...config, options: { value: secondValue } },
    previous: unchanged.cacheEntry,
  });

  expect(fixture.createCalls()).toBe(2);
  expect(unchanged.provider?.model).toBe(first.provider?.model);
  expect(changed.provider?.model).not.toBe(first.provider?.model);
  expect(observed).toHaveLength(2);
  expect((observed[0] as { value: unknown }).value).toBeInstanceOf(transformedType);
});

test("an in-place nested account-option transform cannot change the pre-transform runtime identity input", async () => {
  const fixture = runtimeFixture(
    { kind: "static" },
    {
      accountOptionsSchema: zod.object({ nested: zod.any() }).transform(({ nested }) => {
        nested.value = new URL(nested.value as string);
        return { nested };
      }),
    },
  );
  const base = {
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  } as const;
  const config = {
    id: "person",
    kind: ProviderKind.OAuth,
    enabled: true,
    plugin: "@example/oauth",
    capability: "default",
  } as const;

  const first = await materializePluginProvider({
    ...base,
    config: { ...config, options: { nested: { value: "https://one.example.test" } } },
  });
  const unchanged = await materializePluginProvider({
    ...base,
    config: { ...config, options: { nested: { value: "https://one.example.test" } } },
    previous: first.cacheEntry,
  });
  await materializePluginProvider({
    ...base,
    config: { ...config, options: { nested: { value: "https://two.example.test" } } },
    previous: unchanged.cacheEntry,
  });

  expect(fixture.createCalls()).toBe(2);
});

test("plugin raw capability receives catalog metadata and rejects malformed transports", async () => {
  const observed: unknown[] = [];
  const fixture = runtimeFixture(
    { kind: "static" },
    {
      catalog: { ...catalog, language: [{ id: "model", displayName: "Model", metadata: { region: "us" } }] },
      createRuntime: async () =>
        ({
          provider: {
            specificationVersion: "v4",
            languageModel() {
              throw new Error("not called");
            },
            imageModel() {
              throw new Error("not called");
            },
            embeddingModel() {
              throw new Error("not called");
            },
          },
          raw(input) {
            observed.push(input);
            if (input.modelId === "bad-resolver") return { invoke: "invalid" } as never;
            if (input.modelId === "bad-response") return { invoke: async () => ({}) } as never;
            return { invoke: async () => new Response("ok") };
          },
        }) as never,
    },
  );
  fixture.repository.writeCatalog(
    "person",
    {
      ...catalog,
      language: [
        { id: "model", displayName: "Model", metadata: { region: "us" } },
        { id: "bad-resolver" },
        { id: "bad-response" },
      ],
    },
    1_000,
  );
  const result = await materializePluginProvider({
    config: {
      id: "person",
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: "@example/oauth",
      capability: "default",
      alias: { client: { model: "model", preserve: false } },
    },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  });

  const transport = result.provider?.raw?.resolve({ protocol: ProviderProtocol.OpenAICompatible, modelId: "model" });
  expect(await transport?.invoke(new Request("https://example.test"))).toBeInstanceOf(Response);
  expect(observed[0]).toEqual({ protocol: "openai-compatible", modelId: "model", metadata: { region: "us" } });
  expect(result.provider?.modelMetadata?.["model"]).toEqual({ displayName: "Model" });
  expect(result.summary.clientModels).toEqual(["client", "bad-resolver", "bad-response"]);
  expect(() =>
    result.provider?.raw?.resolve({ protocol: ProviderProtocol.OpenAICompatible, modelId: "bad-resolver" }),
  ).toThrow(PluginRawResolverError);
  const badResponse = result.provider?.raw?.resolve({
    protocol: ProviderProtocol.OpenAICompatible,
    modelId: "bad-response",
  });
  await expect(badResponse?.invoke(new Request("https://example.test"))).rejects.toBeInstanceOf(
    PluginRawTransportError,
  );
});

test("maps plugin, capability, account, options, credential, catalog, and runtime failures to stable diagnostics", async () => {
  const config = {
    id: "person",
    kind: ProviderKind.OAuth,
    enabled: true,
    plugin: "@example/oauth",
    capability: "default",
  } as const;
  const base = {
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  };
  const fixture = runtimeFixture({ kind: "static" });
  const failedPlugin = await materializePluginProvider({
    ...base,
    config,
    repository: fixture.repository,
    plugins: {
      ...fixture.plugins,
      plugins: new Map([
        [
          "@example/oauth",
          {
            packageName: "@example/oauth",
            version: "1.0.0",
            builtIn: false,
            state: {
              status: "failed",
              diagnostic: diagnostics("PLUGIN_LOAD_FAILED", { retryable: false }),
            },
          },
        ],
      ]),
    } as never,
  });
  const missingCapability = await materializePluginProvider({
    ...base,
    config: { ...config, capability: "missing" },
    repository: fixture.repository,
    plugins: fixture.plugins,
  });
  const missingAccount = await materializePluginProvider({
    ...base,
    config: { ...config, id: "absent" },
    repository: fixture.repository,
    plugins: fixture.plugins,
  });
  const invalidOptions = await materializePluginProvider({
    ...base,
    config: { ...config, options: [] } as never,
    repository: fixture.repository,
    plugins: fixture.plugins,
  });
  const adapter = fixture.plugins.registry.resolveOAuth("@example/oauth", "default");
  expect(adapter).toBeDefined();
  const invalidCredential = await materializePluginProvider({
    ...base,
    config,
    repository: fixture.repository,
    plugins: {
      ...fixture.plugins,
      registry: {
        resolveOAuth: () => ({ ...adapter, credentials: zod.object({ token: zod.number() }) }),
        oauthCapabilities: () => [],
      },
    } as never,
  });
  const missingCatalogFixture = runtimeFixture({ kind: "static" }, { catalog: null });
  const missingCatalog = await materializePluginProvider({
    ...base,
    config,
    repository: missingCatalogFixture.repository,
    plugins: missingCatalogFixture.plugins,
  });
  const failedRuntimeFixture = runtimeFixture(
    { kind: "static" },
    {
      createRuntime: async () => {
        throw new Error("runtime failed");
      },
    },
  );
  const failedRuntime = await materializePluginProvider({
    ...base,
    config,
    repository: failedRuntimeFixture.repository,
    plugins: failedRuntimeFixture.plugins,
  });

  expect([
    failedPlugin.state.diagnostic?.code,
    missingCapability.state.diagnostic?.code,
    missingAccount.state.diagnostic?.code,
    invalidOptions.state.diagnostic?.code,
    invalidCredential.state.diagnostic?.code,
    missingCatalog.state.diagnostic?.code,
    failedRuntime.state.diagnostic?.code,
  ]).toEqual([
    "PLUGIN_LOAD_FAILED",
    "CAPABILITY_MISSING",
    "CREDENTIALS_MISSING_OR_INVALID",
    "ACCOUNT_OPTIONS_INVALID",
    "CREDENTIALS_MISSING_OR_INVALID",
    "CATALOG_UNAVAILABLE",
    "RUNTIME_CREATE_FAILED",
  ]);
  expect(missingCatalog.catalogJob).toBeDefined();
});

test("only repairable existing-account failures suggest targeted provider login", async () => {
  const config = {
    id: "person",
    kind: ProviderKind.OAuth,
    enabled: true,
    plugin: "@example/oauth",
    capability: "default",
  } as const;
  const base = {
    config,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  };
  const fixture = runtimeFixture({ kind: "static" });
  const missing = await materializePluginProvider({
    ...base,
    config: { ...config, id: "absent" },
    repository: fixture.repository,
    plugins: fixture.plugins,
  });
  const mismatchedAccount = fixture.repository.readAccount("person");
  if (mismatchedAccount === null) throw new Error("account fixture missing");
  const mismatched = await materializePluginProvider({
    ...base,
    repository: {
      readAccount: () => ({ ...mismatchedAccount, capability: "alternate" }),
    } as never,
    plugins: fixture.plugins,
  });
  const invalidOptions = await materializePluginProvider({
    ...base,
    config: { ...config, options: [] } as never,
    repository: fixture.repository,
    plugins: fixture.plugins,
  });
  const adapter = fixture.plugins.registry.resolveOAuth("@example/oauth", "default");
  if (adapter === undefined) throw new Error("adapter fixture missing");
  const invalidCredential = await materializePluginProvider({
    ...base,
    repository: fixture.repository,
    plugins: {
      ...fixture.plugins,
      registry: {
        resolveOAuth: () => ({ ...adapter, credentials: zod.object({ token: zod.number() }) }),
        oauthCapabilities: () => [],
      },
    } as never,
  });
  const refreshFixture = runtimeFixture({ kind: "static" });
  refreshFixture.repository.writeDiagnostic("person", {
    code: "CREDENTIAL_REFRESH_FAILED",
    summary: "refresh failed",
    retryable: true,
    occurredAt: new Date(0).toISOString(),
  });
  const refreshFailure = await materializePluginProvider({
    ...base,
    repository: refreshFixture.repository,
    plugins: refreshFixture.plugins,
  });

  expect([
    missing.state.diagnostic?.suggestedCommand,
    mismatched.state.diagnostic?.suggestedCommand,
    invalidOptions.state.diagnostic?.suggestedCommand,
    invalidCredential.state.diagnostic?.suggestedCommand,
    refreshFailure.state.diagnostic?.suggestedCommand,
  ]).toEqual([
    undefined,
    undefined,
    "aio-proxy provider login --provider person",
    "aio-proxy provider login --provider person",
    "aio-proxy provider login --provider person",
  ]);
});

test.each([
  [
    "throws",
    {
      safeParse() {},
      safeParseAsync() {
        throw new Error("schema exploded");
      },
    },
  ],
  [
    "returns a malformed result",
    {
      safeParse() {},
      async safeParseAsync() {
        return { success: "yes" };
      },
    },
  ],
])("a credential schema that %s fails only its provider with a contract diagnostic", async (_name, schema) => {
  const broken = runtimeFixture({ kind: "static" }, { providerId: "broken" });
  const healthy = runtimeFixture({ kind: "static" }, { providerId: "healthy" });
  const adapter = broken.plugins.registry.resolveOAuth("@example/oauth", "default");
  if (adapter === undefined) throw new Error("adapter fixture missing");
  const contexts: unknown[] = [];
  const localDiagnostics: DiagnosticFactory = (code, options) => {
    contexts.push({ code, ...options });
    return diagnostics(code, options);
  };
  const config = (id: string) =>
    ({
      id,
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: "@example/oauth",
      capability: "default",
    }) as const;

  const [brokenResult, healthyResult] = await Promise.all([
    materializePluginProvider({
      config: config("broken"),
      repository: broken.repository,
      plugins: {
        ...broken.plugins,
        registry: {
          resolveOAuth: () => ({ ...adapter, credentials: schema }),
          oauthCapabilities: () => [],
        },
      } as never,
      diagnostics: localDiagnostics,
      logger: () => {},
      onDiagnosticChanged: () => {},
    }),
    materializePluginProvider({
      config: config("healthy"),
      repository: healthy.repository,
      plugins: healthy.plugins,
      diagnostics: localDiagnostics,
      logger: () => {},
      onDiagnosticChanged: () => {},
    }),
  ]);

  expect(brokenResult.state).toMatchObject({
    status: "unavailable",
    diagnostic: { code: "PLUGIN_LOAD_FAILED" },
  });
  expect(brokenResult.state.diagnostic?.suggestedCommand).toBeUndefined();
  expect(healthyResult.state.status).toBe("ready");
  expect(contexts).toContainEqual({
    code: "PLUGIN_LOAD_FAILED",
    plugin: "@example/oauth",
    capability: "default",
    providerId: "broken",
    retryable: false,
  });
});

test("runtime creation timeout isolates a hung provider from another provider materialization", async () => {
  const hung = runtimeFixture({ kind: "static" }, { createRuntime: async () => new Promise<never>(() => {}) });
  const fast = runtimeFixture({ kind: "static" });
  const options = {
    config: {
      id: "person",
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: "@example/oauth",
      capability: "default",
    },
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  } as const;
  let hungSettled = false;
  const hungResult = materializePluginProvider({ ...options, repository: hung.repository, plugins: hung.plugins });
  void hungResult.then(() => {
    hungSettled = true;
  });
  const fastResult = await materializePluginProvider({
    ...options,
    repository: fast.repository,
    plugins: fast.plugins,
  });

  expect(fastResult.state).toMatchObject({ status: "ready" });
  expect(hungSettled).toBe(false);
  expect((await hungResult).state).toMatchObject({
    status: "unavailable",
    diagnostic: { code: "RUNTIME_CREATE_FAILED" },
  });
}, 7_000);

test("plugin descriptor import is cached while setup runs for every registry snapshot", async () => {
  let imports = 0;
  let setups = 0;
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-import-cache-"));
  const packageName = "@example/cache-test";
  const packageDir = join(home, "packages", encodeURIComponent(packageName), "node_modules", "@example", "cache-test");
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ version: "1.0.0", main: "index.js" }));
  writeFileSync(join(packageDir, "index.js"), "export default {};");
  const previousHome = process.env.AIO_PROXY_HOME;
  process.env.AIO_PROXY_HOME = home;
  const descriptor = definePlugin(() => {
    setups++;
  });
  const options = {
    enablements: [{ packageName }],
    builtIns: [],
    diagnostics,
    importPackage: async () => {
      imports++;
      return { default: descriptor };
    },
    logger: () => {},
    secrets: { readPluginSecret: () => undefined },
  } as const;

  try {
    await loadPluginRegistry(options);
    await loadPluginRegistry(options);

    expect(imports).toBe(1);
    expect(setups).toBe(2);
  } finally {
    if (previousHome === undefined) delete process.env.AIO_PROXY_HOME;
    else process.env.AIO_PROXY_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("diagnostic-only rebuild reuses the runtime and credential port", async () => {
  const fixture = runtimeFixture({ kind: "static" });
  const options = {
    config: {
      id: "person",
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: "@example/oauth",
      capability: "default",
    },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  } as const;
  const first = await materializePluginProvider(options);
  fixture.repository.writeDiagnostic(
    "person",
    diagnostics("CATALOG_UNAVAILABLE", { providerId: "person", retryable: true }),
  );
  const second = await materializePluginProvider({ ...options, previous: first.cacheEntry });

  expect(fixture.createCalls()).toBe(1);
  expect(second.cacheEntry?.credentials).toBe(first.cacheEntry?.credentials);
  expect(second.provider?.model).toBe(first.provider?.model);
  expect(second.state).toMatchObject({
    status: "ready",
    catalog: "stale",
    diagnostic: { code: "CATALOG_UNAVAILABLE" },
  });
});

test("credential revision refresh stays visible without rebuilding the runtime", async () => {
  const fixture = runtimeFixture({ kind: "static" });
  const options = {
    config: {
      id: "person",
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: "@example/oauth",
      capability: "default",
    },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  } as const;
  const first = await materializePluginProvider(options);
  const before = await first.cacheEntry?.credentials.read();
  expect(before).toBeDefined();
  fixture.repository.compareAndSwapCredential("person", before?.revision ?? -1, { token: "new-secret" });
  const second = await materializePluginProvider({ ...options, previous: first.cacheEntry });

  expect(fixture.createCalls()).toBe(1);
  expect(second.cacheEntry?.credentials).toBe(first.cacheEntry?.credentials);
  expect(await second.cacheEntry?.credentials.read()).toMatchObject({ value: { token: "new-secret" } });
});

test("plugin removal drops the runtime capability without deleting the account", async () => {
  const fixture = runtimeFixture({ kind: "static" });
  const config = {
    id: "person",
    kind: ProviderKind.OAuth,
    enabled: true,
    plugin: "@example/oauth",
    capability: "default",
  } as const;
  const first = await materializePluginProvider({
    config,
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  });
  const removed = await materializePluginProvider({
    config,
    plugins: { plugins: new Map(), registry: { resolveOAuth: () => undefined, oauthCapabilities: () => [] } },
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    previous: first.cacheEntry,
  });

  expect(removed.provider).toBeUndefined();
  expect(removed.state).toMatchObject({ diagnostic: { code: "PLUGIN_NOT_INSTALLED" } });
  expect(fixture.repository.readAccount("person")).not.toBeNull();
});
