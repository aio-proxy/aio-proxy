import { afterEach, expect, test } from "bun:test";
import { zod } from "@aio-proxy/plugin-sdk";
import { ProviderKind } from "@aio-proxy/types";
import { pluginOptionsIdentityDigest } from "../../src/plugin-runtime";
import {
  catalog,
  cleanup,
  diagnostics,
  materializePluginProvider,
  refreshCredential,
  runtimeFixture,
} from "./test-support";

afterEach(cleanup);

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
  refreshCredential(fixture.repository, before?.revision ?? -1, { token: "new-secret" });
  const second = await materializePluginProvider({ ...options, previous: first.cacheEntry });

  expect(fixture.createCalls()).toBe(1);
  expect(second.cacheEntry?.credentials).toBe(first.cacheEntry?.credentials);
  expect(await second.cacheEntry?.credentials.read()).toMatchObject({ value: { token: "new-secret" } });
});
