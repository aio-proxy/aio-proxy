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
} from "@aio-proxy/core";
import { type OpenDbHandle, openDb } from "@aio-proxy/core/db";
import { definePlugin, type ModelCatalog, type OAuthAdapter, zod } from "@aio-proxy/plugin-sdk";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import {
  materializePluginProvider,
  PluginRawResolverError,
  PluginRawTransportError,
  validatePluginProtocolMap,
} from "../src/plugin-runtime";

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
});

function runtimeFixture(
  policy: OAuthAdapter["catalog"]["policy"],
  overrides: {
    readonly catalog?: ModelCatalog | null;
    readonly createRuntime?: OAuthAdapter["createRuntime"];
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
  const operation = repository.stageAccountOperation({
    kind: "create",
    targetDigest: "create",
    account: {
      providerId: "person",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "person@example.com",
      options: {},
      secrets: {},
      credential: { token: "secret" },
      catalog:
        fixtureCatalog === null
          ? {
              kind: "missing",
              diagnostic: diagnostics("CATALOG_UNAVAILABLE", { providerId: "person", retryable: true }),
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
    account: { options: { schema: zod.object({}), form: [] } },
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
  const first = await materializePluginProvider({ ...base, pluginOptions: { mode: "one" } });
  const pluginOptionsChanged = await materializePluginProvider({
    ...base,
    pluginOptions: { mode: "two" },
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
    pluginOptions: { mode: "two" },
    previous: pluginOptionsChanged.cacheEntry,
  });
  fixture.repository.writeCatalog("person", catalog, 2_000);
  const refreshed = await materializePluginProvider({
    ...base,
    pluginOptions: { mode: "two" },
    previous: relogged.cacheEntry,
  });

  expect(fixture.createCalls()).toBe(4);
  expect(pluginOptionsChanged.cacheEntry?.identity).not.toBe(first.cacheEntry?.identity);
  expect(relogged.cacheEntry?.identity).not.toBe(pluginOptionsChanged.cacheEntry?.identity);
  expect(refreshed.cacheEntry?.identity).not.toBe(relogged.cacheEntry?.identity);
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
