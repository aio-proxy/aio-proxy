import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRepository } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { ConfigSchema } from "@aio-proxy/types";
import { createDashboardRoutes } from "../src/dashboard-routes/config";
import { createServerState } from "../src/server-state";

import { seedOAuthAccount, waitUntil } from "./dashboard-providers-mutation.oauth.test-support";

describe("dashboard OAuth provider deletion", () => {
  test.each([
    ["invalid", { kind: "oauth", plugin: "@example/oauth", capability: "" }, undefined],
    ["legacy", { kind: "oauth", vendor: "legacy-provider" }, undefined],
    [
      "hybrid legacy",
      { kind: "oauth", vendor: "legacy-provider", plugin: "@example/oauth", capability: "default" },
      { plugin: "@example/other", capability: "alternate" },
    ],
  ])("Dashboard DELETE of an %s OAuth row cascades account state through its CAS marker", async (_label, provider, account) => {
    const dir = mkdtempSync(join(tmpdir(), "aio-dashboard-oauth-delete-"));
    const isolatedConfigPath = join(dir, "config.json");
    const input = { providers: { person: provider } };
    writeFileSync(isolatedConfigPath, JSON.stringify(input));
    const handle = openDb({ home: dir });
    const repository = createPluginRepository(handle.sqlite);
    seedOAuthAccount(repository, account?.plugin, account?.capability);
    const state = await createServerState({
      config: ConfigSchema.parse(input),
      configPath: isolatedConfigPath,
      pluginRepository: repository,
      watchConfig: false,
    });
    const routes = createDashboardRoutes(state);

    try {
      const response = await routes.request("/providers/person", { method: "DELETE" });
      expect(response.status).toBe(200);
      await waitUntil(() => repository.readAccount("person") === null);
      expect(repository.readAccount("person")).toBeNull();
      expect(repository.readCatalog("person")).toBeNull();
      expect(repository.readDiagnostics("person")).toEqual([]);
      expect(repository.listPendingAccountOperations()).toEqual([]);
      expect(
        (JSON.parse(readFileSync(isolatedConfigPath, "utf8")) as { providers: Record<string, unknown> }).providers,
      ).toEqual({});
    } finally {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Dashboard DELETE removes a valid OAuth row whose account is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-dashboard-oauth-config-only-"));
    const isolatedConfigPath = join(dir, "config.json");
    const provider = { kind: "oauth", plugin: "@example/oauth", capability: "default" };
    const input = { providers: { person: provider } };
    writeFileSync(isolatedConfigPath, JSON.stringify(input));
    const handle = openDb({ home: dir });
    const repository = createPluginRepository(handle.sqlite);
    const state = await createServerState({
      config: ConfigSchema.parse(input),
      configPath: isolatedConfigPath,
      pluginRepository: repository,
      watchConfig: false,
    });
    const routes = createDashboardRoutes(state);

    try {
      const response = await routes.request("/providers/person", { method: "DELETE" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, id: "person" });
      expect(
        (JSON.parse(readFileSync(isolatedConfigPath, "utf8")) as { providers: Record<string, unknown> }).providers,
      ).toEqual({});
      expect(repository.readAccount("person")).toBeNull();
      expect(repository.readCatalog("person")).toBeNull();
      expect(repository.readDiagnostics("person")).toEqual([]);
      expect(repository.listPendingAccountOperations()).toEqual([]);
    } finally {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Dashboard DELETE preserves a valid OAuth row with a mismatched account and returns cleanup pending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-dashboard-oauth-pending-"));
    const isolatedConfigPath = join(dir, "config.json");
    const provider = { kind: "oauth", plugin: "@example/oauth", capability: "default" };
    const input = { providers: { person: provider } };
    writeFileSync(isolatedConfigPath, JSON.stringify(input));
    const handle = openDb({ home: dir });
    const repository = createPluginRepository(handle.sqlite);
    const account = { plugin: "@example/other", capability: "alternate" };
    seedOAuthAccount(repository, account.plugin, account.capability);
    const state = await createServerState({
      config: ConfigSchema.parse(input),
      configPath: isolatedConfigPath,
      pluginRepository: repository,
      watchConfig: false,
    });
    const routes = createDashboardRoutes(state);

    try {
      const response = await routes.request("/providers/person", { method: "DELETE" });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "provider account cleanup pending", id: "person" });
      expect(
        (JSON.parse(readFileSync(isolatedConfigPath, "utf8")) as { providers: Record<string, unknown> }).providers,
      ).toEqual({ person: provider });
      expect(repository.listPendingAccountOperations()).toEqual([]);
      expect(repository.readAccount("person")).toMatchObject(account);
    } finally {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Dashboard DELETE returns 409 for an incompatible pending account operation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-dashboard-oauth-conflict-"));
    const isolatedConfigPath = join(dir, "config.json");
    const provider = { kind: "oauth", plugin: "@example/oauth", capability: "default" };
    const input = { providers: { person: provider } };
    writeFileSync(isolatedConfigPath, JSON.stringify(input));
    const handle = openDb({ home: dir });
    const repository = createPluginRepository(handle.sqlite);
    seedOAuthAccount(repository);
    repository.stageAccountOperation({
      kind: "update",
      targetDigest: "update",
      expectedRuntimeRevision: 1,
      account: {
        providerId: "person",
        plugin: "@example/oauth",
        capability: "default",
        fingerprint: "person@example.com",
        options: { generation: 2 },
        secrets: {},
        credential: { token: "secret" },
        catalog: { kind: "preserve", diagnostic: repository.readDiagnostics("person")[0] as never },
      },
    });
    const state = await createServerState({
      config: ConfigSchema.parse(input),
      configPath: isolatedConfigPath,
      pluginRepository: repository,
      watchConfig: false,
    });
    const routes = createDashboardRoutes(state);

    try {
      const response = await routes.request("/providers/person", { method: "DELETE" });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "provider account cleanup pending", id: "person" });
      expect(
        (JSON.parse(readFileSync(isolatedConfigPath, "utf8")) as { providers: Record<string, unknown> }).providers,
      ).toEqual({ person: provider });
      expect(repository.readAccount("person")).not.toBeNull();
    } finally {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
