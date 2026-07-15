import { afterEach, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AtomicConfigFile,
  createPluginRepository,
  ORPHAN_ACCOUNT_GRACE_MS,
  PENDING_OPERATION_TTL_MS,
  type PluginRepository,
  RECOVERY_DRAIN_RETRY_MS,
  Router,
  recoverPendingAccountOperations,
  type TextStreamPart,
  type ToolSet,
} from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { definePlugin, zod } from "@aio-proxy/plugin-sdk";
import { ConfigSchema } from "@aio-proxy/types";
import { createAccountRemovalCoordinator } from "../src/account-removal";
import { createSnapshotManager } from "../src/plugin-snapshot";
import { handleProtocolRequest } from "../src/routes/pipeline";
import { createServerState } from "../src/server-state";
import { createUsageCapture } from "../src/usage-capture";
import {
  createProtocolContext,
  defineProtocolAdapter,
  defineProviderRouteSource,
  jsonRequest,
  modelProvider,
  REQUESTED_MODEL,
  rawProvider,
} from "./pipeline-helpers";

const emptyPlugins = {
  plugins: new Map(),
  registry: { resolveOAuth: () => undefined, oauthCapabilities: () => [] },
};

afterEach(() => {
  jest.useRealTimers();
});

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}

const snapshot = (id: string) => ({
  plugins: emptyPlugins,
  providers: [{ id, kind: "api", enabled: true, models: ["model"] }] as never,
  router: new Router([{ id, enabled: true, models: ["model"] }]),
});

function seedOAuthAccount(repository: PluginRepository, catalog: "missing" | "ready" = "ready"): void {
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
        catalog === "ready"
          ? {
              kind: "replace",
              value: {
                catalog: {
                  language: [{ id: "model" }],
                  image: [],
                  embedding: [],
                  speech: [],
                  transcription: [],
                  reranking: [],
                },
                refreshedAt: Date.now(),
              },
            }
          : {
              kind: "missing",
              diagnostic: {
                code: "CATALOG_UNAVAILABLE",
                summary: "catalog unavailable",
                retryable: true,
                occurredAt: new Date(0).toISOString(),
              },
            },
    },
  });
  repository.completeAccountOperation(operation.operationId);
}

test("an acquired old snapshot drains only after its one-shot lease releases", async () => {
  const manager = createSnapshotManager(snapshot("old"));
  const lease = manager.acquire();
  const retired = manager.swap(snapshot("new"));

  expect(manager.current().providers[0]?.id).toBe("new");
  expect(manager.canDeleteAccount("old")).toBe(false);
  let drained = false;
  void retired.whenDrained.then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);

  lease.release();
  lease.release();
  await retired.whenDrained;
  expect(manager.canDeleteAccount("old")).toBe(true);
});

test("an in-flight protocol response retains its old provider snapshot until the body completes", async () => {
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const old = rawProvider({
    id: "old",
    modelId: REQUESTED_MODEL,
    invoke: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
          },
        }),
      ),
  });
  const next = rawProvider({ id: "next", modelId: REQUESTED_MODEL });
  const manager = createSnapshotManager({
    plugins: emptyPlugins as never,
    providers: [old.provider],
    router: new Router([old.provider]),
  });
  const base = defineProviderRouteSource([old]);
  const source = {
    ...base.source,
    acquireProviderSnapshot: manager.acquire,
    currentProviderSnapshot: manager.current,
    usageCapture: createUsageCapture({ priceCatalogTask: async () => undefined }),
  };
  const response = await handleProtocolRequest({
    adapter: defineProtocolAdapter(),
    context: createProtocolContext(),
    rawRequest: jsonRequest({ model: REQUESTED_MODEL }),
    source,
  });
  const retired = manager.swap({
    plugins: emptyPlugins as never,
    providers: [next.provider],
    router: new Router([next.provider]),
  });

  expect(manager.canDeleteAccount("old")).toBe(false);
  bodyController?.enqueue(new TextEncoder().encode('{"ok":true}'));
  bodyController?.close();
  expect(await response.text()).toBe('{"ok":true}');
  await retired.whenDrained;
  expect(manager.canDeleteAccount("old")).toBe(true);
});

test.each([
  "EOF",
  "cancel",
] as const)("an in-flight model stream retains its old provider snapshot until response %s", async (completion) => {
  let modelController: ReadableStreamDefaultController<TextStreamPart<ToolSet>> | undefined;
  const old = modelProvider({
    id: "old",
    modelId: REQUESTED_MODEL,
    invoke: () =>
      new ReadableStream<TextStreamPart<ToolSet>>({
        start(controller) {
          modelController = controller;
          controller.enqueue({ type: "text-delta", id: "text-1", text: "old" });
        },
      }),
  });
  const next = modelProvider({
    id: "next",
    modelId: REQUESTED_MODEL,
    invoke: () => new ReadableStream<TextStreamPart<ToolSet>>({ start: (controller) => controller.close() }),
  });
  const manager = createSnapshotManager({
    plugins: emptyPlugins as never,
    providers: [old.provider],
    router: new Router([old.provider]),
  });
  const base = defineProviderRouteSource([old]);
  const source = {
    ...base.source,
    acquireProviderSnapshot: manager.acquire,
    currentProviderSnapshot: manager.current,
    usageCapture: createUsageCapture({ priceCatalogTask: async () => undefined }),
  };
  const response = await handleProtocolRequest({
    adapter: defineProtocolAdapter(),
    context: createProtocolContext(),
    rawRequest: jsonRequest({ model: REQUESTED_MODEL, stream: true }),
    source,
  });
  const retired = manager.swap({
    plugins: emptyPlugins as never,
    providers: [next.provider],
    router: new Router([next.provider]),
  });

  expect(manager.canDeleteAccount("old")).toBe(false);
  if (completion === "EOF") {
    modelController?.close();
    expect(await response.text()).toContain('data: {"text":"old"}');
  } else {
    await response.body?.cancel();
  }
  await retired.whenDrained;
  expect(manager.canDeleteAccount("old")).toBe(true);
});

test("a final raw error response retains its old provider snapshot until the body completes", async () => {
  let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const old = rawProvider({
    id: "old",
    modelId: REQUESTED_MODEL,
    invoke: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            bodyController = controller;
          },
        }),
        { status: 500 },
      ),
  });
  const manager = createSnapshotManager({
    plugins: emptyPlugins as never,
    providers: [old.provider],
    router: new Router([old.provider]),
  });
  const base = defineProviderRouteSource([old]);
  const source = {
    ...base.source,
    acquireProviderSnapshot: manager.acquire,
    currentProviderSnapshot: manager.current,
  };
  const response = await handleProtocolRequest({
    adapter: defineProtocolAdapter(),
    context: createProtocolContext(),
    rawRequest: jsonRequest({ model: REQUESTED_MODEL }),
    source,
  });
  const retired = manager.swap({ ...snapshot("empty"), providers: [] });

  expect(response.status).toBe(500);
  expect(manager.canDeleteAccount("old")).toBe(false);
  bodyController?.enqueue(new TextEncoder().encode("upstream failed"));
  bodyController?.close();
  expect(await response.text()).toBe("upstream failed");
  await retired.whenDrained;
  expect(manager.canDeleteAccount("old")).toBe(true);
});

test("OAuth deletion cascades account data only after the retired snapshot drains", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-delete-drain-"));
  const configPath = join(home, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      providers: { person: { kind: "oauth", plugin: "@example/oauth", capability: "default" } },
    }),
  );
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  repository.writeDiagnostic("person", {
    code: "CREDENTIAL_REFRESH_FAILED",
    summary: "refresh failed",
    retryable: true,
    occurredAt: new Date(0).toISOString(),
  });
  const file = new AtomicConfigFile(configPath);
  const removals = createAccountRemovalCoordinator({ file, repository });
  let operations: ReturnType<typeof removals.stageRemoved> = [];
  await file.transaction(async (current) => {
    const providers = current["providers"] as Record<string, unknown>;
    operations = removals.stageRemoved(providers, {});
    return { next: { ...current, providers: {} }, result: undefined };
  });
  const manager = createSnapshotManager(snapshot("person"));
  const lease = manager.acquire();
  const retired = manager.swap({ ...snapshot("empty"), providers: [] });
  const finalized = removals.finalizeAfterDrain(operations, retired);

  await Bun.sleep(0);
  expect(repository.readAccount("person")).not.toBeNull();
  lease.release();
  await finalized;
  expect(repository.readAccount("person")).toBeNull();
  expect(repository.readCatalog("person")).toBeNull();
  expect(repository.readDiagnostics("person")).toEqual([]);
  handle.close();
  rmSync(home, { recursive: true, force: true });
});

test("OAuth deletion waits for every older retired snapshot containing the provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-delete-all-retired-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: {} }));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  const file = new AtomicConfigFile(configPath);
  const removals = createAccountRemovalCoordinator({ file, repository });
  const operations = removals.stageRemoved(
    { person: { kind: "oauth", plugin: "@example/oauth", capability: "default" } },
    {},
  );
  const manager = createSnapshotManager(snapshot("person"));
  const oldestLease = manager.acquire();
  manager.swap({ ...snapshot("unavailable"), providers: [] });
  const deletionRetired = manager.swap({ ...snapshot("empty"), providers: [] });
  const finalized = removals.finalizeAfterDrain(operations, deletionRetired);

  const finalizedBeforeOldestDrain = await Promise.race([finalized.then(() => true), Bun.sleep(120).then(() => false)]);
  oldestLease.release();
  await finalized;
  expect(finalizedBeforeOldestDrain).toBe(false);
  expect(repository.readAccount("person")).toBeNull();
  handle.close();
  rmSync(home, { recursive: true, force: true });
});

test("pending deletion recovery is gated by current and undrained retired snapshots", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-recovery-gate-"));
  const configPath = join(home, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      providers: { person: { kind: "oauth", plugin: "@example/oauth", capability: "default" } },
    }),
  );
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  const file = new AtomicConfigFile(configPath);
  const removals = createAccountRemovalCoordinator({ file, repository });
  await file.transaction(async (current) => {
    const providers = current["providers"] as Record<string, unknown>;
    removals.stageRemoved(providers, {});
    return { next: { ...current, providers: {} }, result: undefined };
  });
  const manager = createSnapshotManager(snapshot("person"));
  const lease = manager.acquire();
  const retired = manager.swap({ ...snapshot("empty"), providers: [] });
  const later = Date.now() + 60 * 60_000;

  const gated = await recoverPendingAccountOperations(file, repository, {
    mode: "server",
    now: () => later,
    canDeleteAccount: manager.canDeleteAccount,
  });
  expect(repository.readAccount("person")).not.toBeNull();
  expect(gated.nextRunAt).toBeDefined();

  lease.release();
  await retired.whenDrained;
  await recoverPendingAccountOperations(file, repository, {
    mode: "server",
    now: () => later,
    canDeleteAccount: manager.canDeleteAccount,
  });
  expect(repository.readAccount("person")).toBeNull();
  handle.close();
  rmSync(home, { recursive: true, force: true });
});

test("overlapping slow and fast reloads commit in serialized file-read order", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-overlapping-reload-"));
  const configPath = join(home, "config.json");
  const initialInput = {
    providers: {
      person: {
        kind: "oauth",
        plugin: "@example/oauth",
        capability: "default",
        options: { marker: "initial" },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(initialInput));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  handle.close();
  let markSlowStarted = () => {};
  const slowStarted = new Promise<void>((resolve) => {
    markSlowStarted = resolve;
  });
  let releaseSlow = () => {};
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const created: string[] = [];
  const descriptor = definePlugin((api) => {
    api.oauth.register({
      id: "default",
      label: "Example",
      account: {
        options: { schema: zod.object({ marker: zod.string() }), form: [] },
      },
      credentials: zod.object({ token: zod.string() }),
      async login() {
        throw new Error("not called");
      },
      catalog: {
        policy: { kind: "static" },
        async discover() {
          throw new Error("not called");
        },
      },
      async createRuntime({ options }) {
        const marker = (options as { marker: string }).marker;
        created.push(marker);
        if (marker === "slow") {
          markSlowStarted();
          await slowGate;
        }
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
    config: ConfigSchema.parse(initialInput),
    configPath,
    watchConfig: false,
    dbHome: home,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor }],
  });

  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          person: {
            kind: "oauth",
            plugin: "@example/oauth",
            capability: "default",
            options: { marker: "slow" },
          },
        },
      }),
    );
    const slowReload = state.reload();
    await slowStarted;
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          person: {
            kind: "oauth",
            plugin: "@example/oauth",
            capability: "default",
            options: { marker: "fast" },
          },
        },
      }),
    );
    const fastReload = state.reload();
    releaseSlow();

    expect(await slowReload).toMatchObject({ ok: true });
    expect(await fastReload).toMatchObject({ ok: true });
    expect(state.currentConfig().providers[0]).toMatchObject({ options: { marker: "fast" } });
    expect(created).toEqual(["initial", "slow", "fast"]);
  } finally {
    releaseSlow();
    state.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a failed candidate preserves the prior snapshot and never starts its catalog job", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-failed-candidate-"));
  const configPath = join(home, "config.json");
  const initialInput = {
    providers: {
      stable: {
        kind: "api",
        protocol: "openai-compatible",
        baseURL: "https://stable.example.test/v1",
        models: ["stable-model"],
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(initialInput));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository, "missing");
  handle.close();
  let discoveries = 0;
  let routerBuilds = 0;
  let jobReplacements = 0;
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
          discoveries++;
          return {
            language: [{ id: "model" }],
            image: [],
            embedding: [],
            speech: [],
            transcription: [],
            reranking: [],
          };
        },
      },
      async createRuntime() {
        throw new Error("catalog is unavailable");
      },
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse(initialInput),
    configPath,
    watchConfig: false,
    dbHome: home,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor }],
    logger: () => {},
    __test: {
      createRouter(providers: never[]) {
        routerBuilds++;
        if (routerBuilds === 2) throw new Error("candidate finalization failed");
        return new Router(providers);
      },
      onCatalogJobsReplaced() {
        jobReplacements++;
      },
    },
  } as never);
  const before = state.currentProviderSnapshot();

  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          stable: {
            kind: "api",
            protocol: "openai-compatible",
            baseURL: "https://stable.example.test/v1",
            models: ["stable-model"],
          },
          person: {
            kind: "oauth",
            plugin: "@example/oauth",
            capability: "default",
          },
        },
      }),
    );
    const result = await state.reload();
    await Bun.sleep(20);

    expect(result).toMatchObject({ ok: false, stage: "providers" });
    expect(state.currentProviderSnapshot()).toBe(before);
    expect(jobReplacements).toBe(1);
    expect(discoveries).toBe(0);
  } finally {
    state.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a root config parse failure preserves the prior snapshot", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-root-parse-failure-"));
  const configPath = join(home, "config.json");
  const initialInput = {
    providers: {
      stable: {
        kind: "api",
        protocol: "openai-compatible",
        baseURL: "https://stable.example.test/v1",
        models: ["stable-model"],
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(initialInput));
  const state = await createServerState({
    config: ConfigSchema.parse(initialInput),
    configPath,
    watchConfig: false,
    dbHome: home,
    logger: () => {},
  });
  const before = state.currentProviderSnapshot();

  try {
    writeFileSync(configPath, JSON.stringify({ providers: [] }));
    expect(await state.reload()).toMatchObject({ ok: false, stage: "parse" });
    expect(state.currentProviderSnapshot()).toBe(before);
  } finally {
    state.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("failed plugin setup remains snapshot data and does not block API or AI SDK providers", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-failed-plugin-isolation-"));
  const descriptor = definePlugin(() => {
    throw new Error("setup failed");
  });
  const state = await createServerState({
    config: ConfigSchema.parse({
      providers: {
        stable: {
          kind: "api",
          protocol: "openai-compatible",
          baseURL: "https://stable.example.test/v1",
          models: ["stable-model"],
        },
        sdk: {
          kind: "ai-sdk",
          packageName: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://sdk.example.test/v1", name: "sdk" },
          models: ["sdk-model"],
        },
      },
    }),
    dbHome: home,
    builtIns: [{ packageName: "@example/broken", version: "1.0.0", descriptor }],
    pluginLogger: () => {},
  });

  try {
    expect(state.currentProviderSnapshot().plugins.plugins.get("@example/broken")).toMatchObject({
      state: { status: "failed", diagnostic: { code: "PLUGIN_LOAD_FAILED" } },
    });
    expect(state.currentProviderSnapshot().router.resolve("stable-model")[0]?.provider.id).toBe("stable");
    expect(state.currentProviderSnapshot().router.resolve("sdk-model")[0]?.provider.id).toBe("sdk");
  } finally {
    state.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("invalid and legacy provider summaries remain visible but never enter Router candidates", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-invalid-router-exclusion-"));
  const state = await createServerState({
    config: ConfigSchema.parse({
      providers: {
        invalid: {
          kind: "api",
          protocol: "openai-compatible",
          models: ["invalid-model"],
        },
        legacy: {
          kind: "oauth",
          vendor: "legacy-provider",
          models: ["legacy-model"],
        },
        stable: {
          kind: "api",
          protocol: "openai-compatible",
          baseURL: "https://stable.example.test/v1",
          models: ["stable-model"],
        },
      },
    }),
    dbHome: home,
  });

  try {
    const summaries = await state.providerSummaries({ probe: false });
    expect(summaries.map(({ id, enabled }) => ({ id, enabled }))).toEqual([
      { id: "invalid", enabled: false },
      { id: "legacy", enabled: false },
      { id: "stable", enabled: true },
    ]);
    expect(summaries.find(({ id }) => id === "invalid")).toMatchObject({
      kind: "api",
      state: { status: "unavailable", diagnostic: { code: "PROVIDER_CONFIG_INVALID" } },
    });
    const legacy = summaries.find(({ id }) => id === "legacy");
    expect(legacy).toMatchObject({
      kind: "oauth",
      state: {
        status: "unavailable",
        diagnostic: {
          code: "LEGACY_OAUTH_CONFIG_UNSUPPORTED",
        },
      },
    });
    expect(legacy?.state.diagnostic?.summary).toMatch(/delete/iu);
    expect(legacy?.state.diagnostic?.suggestedCommand).toBeUndefined();
    expect(state.currentProviderSnapshot().providers.map(({ id }) => id)).toEqual(["stable"]);
    expect(state.currentProviderSnapshot().router.resolve("stable-model")[0]?.provider.id).toBe("stable");
    expect(() => state.currentProviderSnapshot().router.resolve("invalid-model")).toThrow();
    expect(() => state.currentProviderSnapshot().router.resolve("legacy-model")).toThrow();
  } finally {
    state.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("removing an OAuth account during discovery discards the late catalog and cannot resurrect the provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-remove-during-discovery-"));
  const configPath = join(home, "config.json");
  const initialInput = {
    providers: {
      person: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
    },
  };
  writeFileSync(configPath, JSON.stringify(initialInput));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository, "missing");
  const discoveryStarted = deferred();
  const releaseDiscovery = deferred<{
    language: { id: string }[];
    image: never[];
    embedding: never[];
    speech: never[];
    transcription: never[];
    reranking: never[];
  }>();
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
          discoveryStarted.resolve();
          return releaseDiscovery.promise;
        },
      },
      async createRuntime() {
        throw new Error("must not run without a catalog");
      },
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse(initialInput),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginRepository: repository,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor }],
    pluginLogger: () => {},
  });

  try {
    await discoveryStarted.promise;
    writeFileSync(configPath, JSON.stringify({ providers: {} }));
    expect(await state.reload()).toMatchObject({ ok: true });
    expect(state.currentProviderSnapshot().providers).toEqual([]);
    expect(() => state.currentProviderSnapshot().router.resolve("model")).toThrow();

    releaseDiscovery.resolve({
      language: [{ id: "model" }],
      image: [],
      embedding: [],
      speech: [],
      transcription: [],
      reranking: [],
    });
    await waitUntil(() => repository.readAccount("person") === null);
    await Bun.sleep(20);

    expect(repository.readCatalog("person")).toBeNull();
    expect(state.currentProviderSnapshot().providers).toEqual([]);
    expect(() => state.currentProviderSnapshot().router.resolve("model")).toThrow();
  } finally {
    releaseDiscovery.resolve({
      language: [],
      image: [],
      embedding: [],
      speech: [],
      transcription: [],
      reranking: [],
    });
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a credential diagnostic raised during initial runtime creation rebuilds after manager initialization", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-startup-diagnostic-"));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
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
      catalog: {
        kind: "replace",
        value: {
          catalog: {
            language: [{ id: "model" }],
            image: [],
            embedding: [],
            speech: [],
            transcription: [],
            reranking: [],
          },
          refreshedAt: Date.now(),
        },
      },
    },
  });
  repository.completeAccountOperation(operation.operationId);
  handle.close();
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
          throw new Error("not called");
        },
      },
      async createRuntime({ credentials }) {
        const current = await credentials.read();
        await credentials
          .refresh(current.revision, async () => {
            throw new Error("startup refresh failed");
          })
          .catch(() => {});
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
        person: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
      },
    }),
    dbHome: home,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor }],
    pluginLogger: () => {},
  });

  try {
    expect(state.currentProviderSnapshot().providerStates?.get("person")).toMatchObject({
      status: "unavailable",
      diagnostic: { code: "CREDENTIAL_REFRESH_FAILED" },
    });
  } finally {
    state.close();
    rmSync(home, { force: true, recursive: true });
  }
});

test("server recovery schedules the returned deadline and close prevents an in-flight run from rearming", async () => {
  jest.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-recovery-timer-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: {} }));
  const recoveryStarted = deferred();
  const releaseRecovery = deferred();
  let recoveries = 0;
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    configPath,
    watchConfig: false,
    dbHome: home,
    __test: {
      async recoverPendingAccountOperations() {
        recoveries++;
        if (recoveries === 1) return {};
        if (recoveries === 2) return { nextRunAt: Date.now() + 100 };
        if (recoveries === 3) {
          recoveryStarted.resolve();
          await releaseRecovery.promise;
          return { nextRunAt: Date.now() + 100 };
        }
        return {};
      },
    },
  } as never);

  try {
    expect(recoveries).toBe(2);
    jest.advanceTimersByTime(99);
    await flushMicrotasks();
    expect(recoveries).toBe(2);
    jest.advanceTimersByTime(1);
    await recoveryStarted.promise;
    expect(recoveries).toBe(3);

    state.close();
    releaseRecovery.resolve();
    await flushMicrotasks();
    jest.advanceTimersByTime(1_000);
    await flushMicrotasks();
    expect(recoveries).toBe(3);
  } finally {
    releaseRecovery.resolve();
    state.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a rejected recovery run is logged with a fixed payload and retried", async () => {
  jest.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-recovery-rejection-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: {} }));
  let recoveries = 0;
  const logs: unknown[] = [];
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginLogger: (entry) => logs.push(entry),
    __test: {
      async recoverPendingAccountOperations() {
        recoveries++;
        if (recoveries === 1) return {};
        if (recoveries === 2) return { nextRunAt: Date.now() + 100 };
        if (recoveries === 3) throw new Error("transient recovery failure");
        return {};
      },
    },
  } as never);

  try {
    expect(recoveries).toBe(2);
    jest.advanceTimersByTime(100);
    await flushMicrotasks();
    expect(recoveries).toBe(3);
    expect(logs).toEqual([
      {
        event: "plugin.account.recovery.failed",
        code: "ACCOUNT_RECOVERY_FAILED",
        context: {},
        error: { name: "Error", message: "Pending account recovery failed" },
      },
    ]);

    jest.advanceTimersByTime(RECOVERY_DRAIN_RETRY_MS - 1);
    await flushMicrotasks();
    expect(recoveries).toBe(3);
    jest.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(recoveries).toBe(4);
  } finally {
    state.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("close prevents an in-flight rejected recovery from logging or rearming", async () => {
  jest.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-recovery-rejection-close-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: {} }));
  const recoveryStarted = deferred();
  const rejectRecovery = deferred();
  let recoveries = 0;
  const logs: unknown[] = [];
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginLogger: (entry) => logs.push(entry),
    __test: {
      async recoverPendingAccountOperations() {
        recoveries++;
        if (recoveries === 1) return {};
        if (recoveries === 2) return { nextRunAt: Date.now() + 100 };
        recoveryStarted.resolve();
        await rejectRecovery.promise;
        throw new Error("secret recovery failure");
      },
    },
  } as never);

  try {
    jest.advanceTimersByTime(100);
    await recoveryStarted.promise;
    expect(recoveries).toBe(3);

    state.close();
    rejectRecovery.resolve();
    await flushMicrotasks();
    jest.advanceTimersByTime(RECOVERY_DRAIN_RETRY_MS);
    await flushMicrotasks();
    expect(recoveries).toBe(3);
    expect(logs).toEqual([]);
  } finally {
    rejectRecovery.resolve();
    state.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a failed delete finalizer is retried by the marker recovery deadline", async () => {
  jest.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-delete-recovery-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: {} }));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  let finalizeAttempts = 0;
  let recoveries = 0;
  const recoveryFinished = deferred();
  const observedRepository = {
    ...repository,
    finalizeDeleteOperation(operationId: string) {
      finalizeAttempts++;
      if (finalizeAttempts === 1) throw new Error("transient finalize failure");
      return repository.finalizeDeleteOperation(operationId);
    },
  };
  const account = repository.readAccount("person");
  if (account === null) throw new Error("account fixture missing");
  const pending = observedRepository.stageAccountOperation({
    kind: "delete",
    targetDigest: "absent",
    providerId: "person",
    expectedRuntimeRevision: account.runtimeRevision,
  });
  expect(() => observedRepository.finalizeDeleteOperation(pending.operationId)).toThrow("transient finalize failure");
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginRepository: observedRepository,
    __test: {
      async recoverPendingAccountOperations(...args: Parameters<typeof recoverPendingAccountOperations>) {
        recoveries++;
        const result = await recoverPendingAccountOperations(...args);
        if (recoveries === 3) recoveryFinished.resolve();
        return result;
      },
    },
  } as never);

  try {
    expect(recoveries).toBe(2);
    expect(finalizeAttempts).toBe(1);
    expect(repository.listPendingAccountOperations()).toHaveLength(1);

    jest.advanceTimersByTime(PENDING_OPERATION_TTL_MS);
    await flushMicrotasks();
    expect(recoveries).toBe(3);
    await recoveryFinished.promise;
    expect(finalizeAttempts).toBe(2);
    expect(repository.readAccount("person")).toBeNull();
    expect(repository.listPendingAccountOperations()).toEqual([]);
  } finally {
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a committed delete marker arms the server recovery timer", async () => {
  jest.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-delete-marker-timer-"));
  const configPath = join(home, "config.json");
  const input = {
    providers: {
      person: { kind: "oauth", plugin: "@example/oauth", capability: "" },
    },
  };
  writeFileSync(configPath, JSON.stringify(input));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  let recoveries = 0;
  const state = await createServerState({
    config: ConfigSchema.parse(input),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginRepository: repository,
    __test: {
      async recoverPendingAccountOperations() {
        recoveries++;
        return {};
      },
    },
  } as never);

  try {
    expect(recoveries).toBe(2);
    await state.configStore.deleteProvider("person");
    jest.advanceTimersByTime(PENDING_OPERATION_TTL_MS);
    await flushMicrotasks();
    expect(recoveries).toBe(3);
  } finally {
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("server recovery schedules the earliest competing orphan and pending deadlines and close clears the later one", async () => {
  jest.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-recovery-earliest-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: {} }));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  const orphanCreate = repository.stageAccountOperation({
    kind: "create",
    targetDigest: "orphan-create",
    account: {
      providerId: "orphan",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "orphan@example.com",
      options: {},
      secrets: {},
      credential: { token: "orphan" },
      catalog: {
        kind: "replace",
        value: {
          catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
          refreshedAt: Date.now(),
        },
      },
    },
  });
  repository.completeAccountOperation(orphanCreate.operationId);
  jest.advanceTimersByTime(100);
  repository.stageAccountOperation({
    kind: "create",
    targetDigest: "pending-create",
    account: {
      providerId: "pending",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "pending@example.com",
      options: {},
      secrets: {},
      credential: { token: "pending" },
      catalog: {
        kind: "replace",
        value: {
          catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
          refreshedAt: Date.now(),
        },
      },
    },
  });
  const orphanDeleted = deferred();
  const observedRepository = {
    ...repository,
    deleteAccount(providerId: string) {
      repository.deleteAccount(providerId);
      if (providerId === "orphan") orphanDeleted.resolve();
    },
  };
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginRepository: observedRepository,
  });

  try {
    expect(ORPHAN_ACCOUNT_GRACE_MS).toBe(PENDING_OPERATION_TTL_MS);
    jest.advanceTimersByTime(ORPHAN_ACCOUNT_GRACE_MS - 101);
    await flushMicrotasks();
    expect(repository.readAccount("orphan")).not.toBeNull();
    expect(repository.readAccount("pending")).not.toBeNull();

    jest.advanceTimersByTime(1);
    await orphanDeleted.promise;
    expect(repository.readAccount("orphan")).toBeNull();
    expect(repository.readAccount("pending")).not.toBeNull();
    expect(repository.listPendingAccountOperations()).toHaveLength(1);

    state.close();
    jest.advanceTimersByTime(1_000);
    await flushMicrotasks();
    expect(repository.readAccount("pending")).not.toBeNull();
    expect(repository.listPendingAccountOperations()).toHaveLength(1);
  } finally {
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});
