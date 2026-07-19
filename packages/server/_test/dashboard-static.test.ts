import { createPluginRepository } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { definePlugin, zod } from "@aio-proxy/plugin-sdk";
import { createServer, directoryDashboardAssets } from "@aio-proxy/server";
import { ConfigSchema } from "@aio-proxy/types";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDashboardRoutes } from "../src/dashboard-routes/config";
import { createServerState } from "../src/server-state";

const config = { providers: {} } as const;

describe("dashboard static routes", () => {
  test("Given built dashboard assets When dashboard paths are requested Then static app and API are separated", async () => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-dashboard-"));
    mkdirSync(join(dir, "static"));
    writeFileSync(join(dir, "index.html"), '<div id="root"></div><script src="/dashboard/static/app.js"></script>');
    writeFileSync(join(dir, "static", "app.js"), "console.log('dashboard');");
    const app = await createServer({ config, dashboardAssets: directoryDashboardAssets(dir) });

    try {
      // When
      const dashboard = await app.request("/dashboard");
      const dashboardSlash = await app.request("/dashboard/");
      const asset = await app.request("/dashboard/static/app.js");
      const missingAsset = await app.request("/dashboard/static/missing.js");
      const frontendRoute = await app.request("/dashboard/providers");
      const api = await app.request("/dashboard/api/config");
      const missingApi = await app.request("/dashboard/api/missing");
      const oldApi = await app.request("/dashboard/config");

      // Then
      expect(dashboard.status).toBe(200);
      expect(await dashboard.text()).toContain("/dashboard/static/app.js");
      expect(dashboardSlash.status).toBe(200);
      expect(await dashboardSlash.text()).toContain("root");
      expect(asset.status).toBe(200);
      expect(await asset.text()).toContain("dashboard");
      expect(missingAsset.status).toBe(404);
      expect(frontendRoute.status).toBe(200);
      expect(await frontendRoute.text()).toContain("root");
      expect(api.status).toBe(200);
      expect(await api.json()).toMatchObject({ providers: expect.any(Array) });
      expect(missingApi.status).toBe(404);
      expect(oldApi.status).toBe(200);
      expect(await oldApi.text()).toContain("root");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("plugin and provider diagnostics never serialize stored secrets or original error stacks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-dashboard-diagnostics-"));
    const handle = openDb({ home: dir });
    const repository = createPluginRepository(handle.sqlite);
    repository.writePluginSecret("@example/broken", null, { token: "plugin-secret-sentinel" });
    const operation = repository.stageAccountOperation({
      kind: "create",
      targetDigest: "create",
      account: {
        providerId: "broken-account",
        plugin: "@example/broken",
        capability: "default",
        fingerprint: "fingerprint-sentinel",
        options: { privateOption: "account-option-sentinel" },
        secrets: { clientSecret: "account-secret-sentinel" },
        credential: { accessToken: "credential-json-sentinel" },
        label: "octocat",
        expiresAt: 1_900_000_000_000,
        catalog: {
          kind: "missing",
          diagnostic: {
            code: "CATALOG_UNAVAILABLE",
            summary: "Catalog unavailable.",
            retryable: true,
            occurredAt: "2026-07-14T00:00:00.000Z",
          },
        },
      },
    });
    repository.completeAccountOperation(operation.operationId);
    const descriptor = definePlugin(
      () => {
        const error = new Error("plugin-secret-sentinel original setup failure");
        error.stack = "original-error-stack-sentinel";
        throw error;
      },
      {
        label: { default: "Broken plugin", "zh-Hans": "损坏的插件" },
        description: { default: "Broken plugin description", "zh-Hans": "损坏插件描述" },
        options: {
          schema: zod.object({ token: zod.string() }),
          form: [{ type: "secret", key: "token", label: "Token" }],
        },
      },
    );
    const state = await createServerState({
      config: ConfigSchema.parse({
        plugins: ["@example/broken"],
        providers: {
          "broken-account": {
            kind: "oauth",
            plugin: "@example/broken",
            capability: "default",
          },
        },
      }),
      dbHome: dir,
      pluginRepository: repository,
      builtIns: [{ packageName: "@example/broken", version: "1.2.3", descriptor }],
      pluginLogger: () => {},
    });
    const routes = createDashboardRoutes(state);

    try {
      const removedPlugins = await routes.request("/plugins");
      const capabilities = await routes.request("/oauth/capabilities");
      const providers = await routes.request("/providers");
      const serialized = JSON.stringify({
        capabilities: await capabilities.json(),
        providers: await providers.json(),
      });

      expect(removedPlugins.status).toBe(404);
      expect(capabilities.status).toBe(200);
      expect(providers.status).toBe(200);
      expect(serialized).toContain("PLUGIN_LOAD_FAILED");
      expect(serialized).toContain('"capabilities":[]');
      expect(serialized).toContain("broken-account");
      expect(serialized).not.toContain("plugin-secret-sentinel");
      expect(serialized).not.toContain("account-option-sentinel");
      expect(serialized).not.toContain("account-secret-sentinel");
      expect(serialized).not.toContain("credential-json-sentinel");
      expect(serialized).not.toContain("fingerprint-sentinel");
      expect(serialized).not.toContain("original-error-stack-sentinel");
    } finally {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
