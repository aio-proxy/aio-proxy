import { createPluginRepository } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { ConfigSchema } from "@aio-proxy/types";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServerState } from "../../src/server-state";
import { cleanup } from "./test-support";

afterEach(cleanup);

test("watcher reload rejects structured OAuth removal when the stored account capability mismatches", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-mismatched-removal-"));
  const configPath = join(home, "config.json");
  const initialInput = {
    providers: {
      person: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
    },
  };
  writeFileSync(configPath, JSON.stringify(initialInput));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  const create = repository.stageAccountOperation({
    kind: "create",
    targetDigest: "create",
    account: {
      providerId: "person",
      plugin: "@example/other",
      capability: "alternate",
      fingerprint: "person@example.com",
      options: {},
      secrets: {},
      credential: { token: "secret" },
      catalog: {
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
  repository.completeAccountOperation(create.operationId);
  const state = await createServerState({
    config: ConfigSchema.parse(initialInput),
    configPath,
    pluginRepository: repository,
    watchConfig: false,
    logger: () => {},
  });
  const before = state.currentProviderSnapshot();

  try {
    writeFileSync(configPath, JSON.stringify({ providers: {} }));
    expect(await state.reload()).toMatchObject({ ok: false, stage: "providers" });
    expect(state.currentProviderSnapshot()).toBe(before);
    expect(state.currentConfig().providers).toHaveLength(1);
    expect(repository.listPendingAccountOperations()).toEqual([]);
    expect(repository.readAccount("person")).toMatchObject({
      plugin: "@example/other",
      capability: "alternate",
    });
  } finally {
    state.close();
    handle.close();
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
