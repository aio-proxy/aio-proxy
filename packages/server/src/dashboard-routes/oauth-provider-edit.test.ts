import { createPluginRepository } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { definePlugin, zod } from "@aio-proxy/plugin-sdk";
import { ConfigSchema } from "@aio-proxy/types";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServerState } from "../server-state";
import { createDashboardRoutes } from "./config";

test("OAuth edit-view is secret-safe and common edits preserve account identity and options", async () => {
  const dir = mkdtempSync(join(tmpdir(), "aio-dashboard-oauth-edit-"));
  const configPath = join(dir, "config.json");
  const input = {
    plugins: ["@example/oauth"],
    providers: {
      person: {
        kind: "oauth",
        plugin: "@example/oauth",
        capability: "default",
        name: "Old name",
        enabled: true,
        weight: 1,
        options: { tenant: "work" },
        alias: { old: { model: "model-1" } },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(input));
  const handle = openDb({ home: dir });
  const repository = createPluginRepository(handle.sqlite);
  const pending = repository.stageAccountOperation({
    kind: "create",
    targetDigest: "seed",
    account: {
      providerId: "person",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "person@example.com",
      options: { tenant: "work" },
      secrets: { token: "stored-secret" },
      credential: { accessToken: "stored-credential" },
      label: "person@example.com",
      catalog: {
        kind: "replace",
        value: {
          refreshedAt: Date.now(),
          catalog: {
            language: [{ id: "model-1" }, { id: "model-2" }],
            image: [],
            embedding: [],
            speech: [],
            transcription: [],
            reranking: [],
          },
        },
      },
    },
  });
  repository.completeAccountOperation(pending.operationId);
  const descriptor = definePlugin((api) => {
    api.oauth.register({
      id: "default",
      label: "Example OAuth",
      account: {
        options: {
          schema: zod.object({ tenant: zod.string(), token: zod.string() }),
          form: [
            { type: "text", key: "tenant", label: "Tenant" },
            { type: "secret", key: "token", label: "Token" },
          ],
        },
      },
      credentials: zod.object({ accessToken: zod.string() }),
      async login() {
        throw new Error("not used");
      },
      catalog: {
        policy: { kind: "static" },
        async discover() {
          throw new Error("not used");
        },
      },
      async createRuntime() {
        throw new Error("not used");
      },
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse(input),
    configPath,
    pluginRepository: repository,
    watchConfig: false,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor }],
  });
  const routes = createDashboardRoutes(state);

  try {
    const editResponse = await routes.request("/providers/person/edit-view");
    expect(editResponse.status).toBe(200);
    const edit = await editResponse.json();
    expect(edit).toMatchObject({
      provider: { id: "person", kind: "oauth", plugin: "@example/oauth", capability: "default" },
      oauth: {
        accountLabel: "person@example.com",
        publicValues: { tenant: "work" },
        models: ["model-1", "model-2"],
        form: [
          { type: "text", key: "tenant", label: "Tenant" },
          { type: "secret", key: "token", label: "Token", configured: true },
        ],
      },
    });
    expect(JSON.stringify(edit)).not.toMatch(/stored-secret|stored-credential/u);

    const update = await routes.request("/providers/person", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "oauth",
        id: "person",
        name: "Personal",
        enabled: false,
        weight: 4,
        alias: { chat: { model: "model-2" } },
      }),
    });
    expect(update.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as { providers: Record<string, unknown> };
    expect(onDisk.providers.person).toEqual({
      kind: "oauth",
      plugin: "@example/oauth",
      capability: "default",
      name: "Personal",
      enabled: false,
      weight: 4,
      options: { tenant: "work" },
      alias: { chat: { model: "model-2", preserve: false } },
    });
  } finally {
    state.close();
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
