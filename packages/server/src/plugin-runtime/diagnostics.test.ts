import { afterEach, expect, test } from "bun:test";
import type { DiagnosticFactory } from "@aio-proxy/core";
import { zod } from "@aio-proxy/plugin-sdk";
import { ProviderKind } from "@aio-proxy/types";
import { cleanup, diagnostics, materializePluginProvider, runtimeFixture } from "./test-support";

afterEach(cleanup);

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
