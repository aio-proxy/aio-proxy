import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRepository, type PluginRepository } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { createServer } from "@aio-proxy/server";
import { ConfigSchema } from "@aio-proxy/types";
import { createDashboardRoutes } from "../src/dashboard-routes/config";
import { createServerState } from "../src/server-state";

// createServer builds ServerState internally from options; CSRF allows only the
// dashboard origin for the configured port, so pin the port to match ORIGIN.
const PORT = 22_079;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const decoder = new TextDecoder();

const seedConfig = {
  providers: {
    "seed-api": {
      kind: "api",
      protocol: "openai-response",
      baseURL: "https://api.example.com",
      apiKey: "sk-preserved-value",
      enabled: true,
      alias: { "gpt-4o": "gpt-4o-upstream" },
    },
    "seed-ai": { kind: "ai-sdk", packageName: "@ai-sdk/openai-compatible", enabled: true },
    "seed-oauth": { kind: "oauth", vendor: "legacy-provider", enabled: true },
  },
};

const tmpDir = mkdtempSync(join(tmpdir(), "aio-test-"));
const configPath = join(tmpDir, "config.jsonc");
writeFileSync(configPath, JSON.stringify(seedConfig, null, 2));

// watchConfig:false — mutateProviders drives reload itself; no watcher needed.
const app = await createServer({ config: seedConfig, configPath, watchConfig: false, port: PORT });

const onDisk = () =>
  JSON.parse(readFileSync(configPath, "utf8")) as { providers: Record<string, Record<string, unknown>> };

const req = (method: string, path: string, body?: unknown) =>
  app.request(`/dashboard/api${path}`, {
    method,
    headers: method === "GET" ? {} : { Origin: ORIGIN, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const postProvider = (body: unknown) => req("POST", "/providers", body);

function seedOAuthAccount(repository: PluginRepository, plugin = "@example/oauth", capability = "default"): void {
  const operation = repository.stageAccountOperation({
    kind: "create",
    targetDigest: "create",
    account: {
      providerId: "person",
      plugin,
      capability,
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
          refreshedAt: 1,
        },
      },
    },
  });
  repository.completeAccountOperation(operation.operationId);
  repository.writeDiagnostic("person", {
    code: "CREDENTIALS_MISSING_OR_INVALID",
    summary: "credential unavailable",
    retryable: false,
    occurredAt: new Date(0).toISOString(),
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}

async function readNextEventText(stream: Response, timeoutMs = 2_000): Promise<string> {
  const reader = stream.body?.getReader();
  if (reader === undefined) {
    throw new Error("dashboard event stream body is missing");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ReadableStreamReadResult<Uint8Array>>((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error("timed out waiting for dashboard event")), timeoutMs);
  });
  try {
    const chunk = await Promise.race([reader.read(), deadline]);
    return chunk.done ? "" : decoder.decode(chunk.value);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    await reader.cancel();
  }
}

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

describe("dashboard provider CRUD", () => {
  test("1. GET /providers list carries clientModels and hasApiKey fields", async () => {
    const res = await req("GET", "/providers");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.providers)).toBe(true);
    expect(body.providers[0]).toHaveProperty("clientModels");
    const api = body.providers.find((provider: { id: string }) => provider.id === "seed-api");
    expect(api).toHaveProperty("clientModels");
    expect(api.hasApiKey).toBe(true);
  });

  test("2. POST new api provider returns 201 and writes it to disk", async () => {
    const res = await req("POST", "/providers", {
      kind: "api",
      id: "newapi",
      protocol: "openai-compatible",
      baseURL: "https://newapi.example.com",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.provider.id).toBe("newapi");
    expect(body.provider.kind).toBe("api");
    expect(onDisk().providers.newapi).toBeDefined();
  });

  test("3. POST duplicate id returns 409", async () => {
    const res = await req("POST", "/providers", {
      kind: "api",
      id: "seed-api",
      protocol: "openai-response",
      baseURL: "https://dup.example.com",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("provider id already exists");
  });

  test("4. POST oauth kind returns 400 (mutation union omits oauth)", async () => {
    const res = await req("POST", "/providers", {
      kind: "oauth",
      id: "newoauth",
      vendor: "legacy-provider",
    });
    expect(res.status).toBe(400);
  });

  test("POST malformed body missing baseURL returns 400 with zod details", async () => {
    const response = await postProvider({
      kind: "api",
      id: "missing-base-url",
      protocol: "openai-compatible",
    });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(
      body.details.some((issue: { path: unknown[] }) => Array.isArray(issue.path) && issue.path.includes("baseURL")),
    ).toBe(true);
  });

  test("POST rejects removed baseUrl spelling", async () => {
    const response = await postProvider({
      kind: "api",
      id: "legacy-spelling",
      protocol: "openai-compatible",
      baseUrl: "https://api.example.com",
    });
    expect(response.status).toBe(400);
  });

  test("6. PUT rename attempt (body.id !== :id) returns 400", async () => {
    const res = await req("PUT", "/providers/seed-api", {
      kind: "api",
      id: "renamed",
      protocol: "openai-response",
      baseURL: "https://api.example.com",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("provider rename not supported");
  });

  test("7. PUT with apiKey omitted preserves the stored key", async () => {
    const res = await req("PUT", "/providers/seed-api", {
      kind: "api",
      id: "seed-api",
      protocol: "openai-response",
      baseURL: "https://api.example.com",
    });
    expect(res.status).toBe(200);
    expect(onDisk().providers["seed-api"].apiKey).toBe("sk-preserved-value");
  });

  test('8. PUT with apiKey: "" preserves the stored key', async () => {
    const res = await req("PUT", "/providers/seed-api", {
      kind: "api",
      id: "seed-api",
      protocol: "openai-response",
      baseURL: "https://api.example.com",
      apiKey: "",
    });
    expect(res.status).toBe(200);
    expect(onDisk().providers["seed-api"].apiKey).toBe("sk-preserved-value");
  });

  test("9. PUT with a new apiKey writes the new value", async () => {
    const res = await req("PUT", "/providers/seed-api", {
      kind: "api",
      id: "seed-api",
      protocol: "openai-response",
      baseURL: "https://api.example.com",
      apiKey: "sk-new-value",
    });
    expect(res.status).toBe(200);
    expect(onDisk().providers["seed-api"].apiKey).toBe("sk-new-value");
  });

  test("10. PUT nonexistent provider returns 404", async () => {
    const res = await req("PUT", "/providers/ghost", {
      kind: "api",
      id: "ghost",
      protocol: "openai-response",
      baseURL: "https://ghost.example.com",
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("provider not found");
  });

  test("11. DELETE seed-oauth removes it from disk", async () => {
    const res = await req("DELETE", "/providers/seed-oauth");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, id: "seed-oauth" });
    expect(onDisk().providers["seed-oauth"]).toBeUndefined();
  });

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

  test("12. DELETE nonexistent provider returns 404", async () => {
    const res = await req("DELETE", "/providers/ghost");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("provider not found");
  });

  test("13. GET edit-view returns hasApiKey:true and no apiKey field", async () => {
    const res = await req("GET", "/providers/seed-api/edit-view");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider.hasApiKey).toBe(true);
    expect(body.provider).not.toHaveProperty("apiKey");
  });

  test("14. SSE config.changed fires after POST", async () => {
    const stream = await req("GET", "/events");
    expect(stream.status).toBe(200);
    const post = await req("POST", "/providers", {
      kind: "api",
      id: "sseapi",
      protocol: "openai-compatible",
      baseURL: "https://sse.example.com",
    });
    expect(post.status).toBe(201);
    const text = await readNextEventText(stream);
    expect(text).toContain("event: config.changed");
  });

  test("15. POST without a configured config path returns 409", async () => {
    const pathless = await createServer({ config: seedConfig, port: PORT });
    const res = await pathless.request("/dashboard/api/providers", {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "api",
        id: "nopath",
        protocol: "openai-response",
        baseURL: "https://nopath.example.com",
      }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("config file path is not configured");
  });

  test("16. PUT preserves stored alias when the mutation body omits it", async () => {
    const res = await req("PUT", "/providers/seed-api", {
      kind: "api",
      id: "seed-api",
      protocol: "openai-response",
      baseURL: "https://changed.example.com",
    });
    expect(res.status).toBe(200);
    expect(onDisk().providers["seed-api"].baseURL).toBe("https://changed.example.com");
    expect(onDisk().providers["seed-api"]).not.toHaveProperty("baseUrl");
    expect(onDisk().providers["seed-api"].alias).toEqual({ "gpt-4o": "gpt-4o-upstream" });
  });

  test("17. GET edit-view includes the alias field for the read-only viewer", async () => {
    const res = await req("GET", "/providers/seed-api/edit-view");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider.alias).toBeDefined();
    expect(body.provider.alias["gpt-4o"].model).toBe("gpt-4o-upstream");
  });

  test("18. PUT that yields an invalid provider degrades that row without rejecting the config", async () => {
    const res = await req("PUT", "/providers/seed-api", {
      kind: "api",
      id: "seed-api",
      protocol: "openai-response",
      baseURL: "https://api.example.com",
      models: ["unrelated-model"],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      provider: { id: "seed-api", enabled: false, clientModels: [] },
    });
    expect(onDisk().providers["seed-api"]).toMatchObject({
      models: ["unrelated-model"],
      alias: { "gpt-4o": "gpt-4o-upstream" },
    });
  });

  test("19. GET /providers surfaces the saved display name for an enabled provider", async () => {
    const put = await req("PUT", "/providers/seed-ai", {
      kind: "ai-sdk",
      id: "seed-ai",
      packageName: "@ai-sdk/openai-compatible",
      name: "My Display Name",
    });
    expect(put.status).toBe(200);
    const res = await req("GET", "/providers");
    const body = await res.json();
    const ai = body.providers.find((provider: { id: string }) => provider.id === "seed-ai");
    expect(ai.name).toBe("My Display Name");
  });

  test("20. GET edit-view redacts nested ai-sdk options secrets", async () => {
    const put = await req("PUT", "/providers/seed-ai", {
      kind: "ai-sdk",
      id: "seed-ai",
      packageName: "@ai-sdk/openai-compatible",
      options: { headers: { Authorization: "Bearer nested-secret" } },
    });
    expect(put.status).toBe(200);
    const res = await req("GET", "/providers/seed-ai/edit-view");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.provider.options.headers.Authorization).toBe("****");
  });

  test("21. POST api provider with models and alias including variants persists alias to disk", async () => {
    const res = await req("POST", "/providers", {
      kind: "api",
      id: "alias-test",
      protocol: "openai-compatible",
      baseURL: "https://alias-test.example.com",
      models: ["gpt-4o-upstream", "o3-upstream"],
      alias: {
        "gpt-4o": {
          model: "gpt-4o-upstream",
          variants: { thinking: { model: "o3-upstream" } },
        },
      },
    });
    expect(res.status).toBe(201);
    const disk = onDisk().providers["alias-test"];
    expect(disk).toBeDefined();
    expect(disk.alias).toBeDefined();
    expect(disk.alias).toMatchObject({
      "gpt-4o": {
        model: "gpt-4o-upstream",
        variants: { thinking: { model: "o3-upstream" } },
      },
    });
  });

  test("22. PUT with a new alias replaces the stored alias", async () => {
    const res = await req("PUT", "/providers/alias-test", {
      kind: "api",
      id: "alias-test",
      protocol: "openai-compatible",
      baseURL: "https://alias-test.example.com",
      models: ["gpt-4o-upstream", "o3-upstream"],
      alias: { "new-alias": { model: "o3-upstream" } },
    });
    expect(res.status).toBe(200);
    const disk = onDisk().providers["alias-test"];
    const alias = disk.alias as Record<string, unknown>;
    expect(alias["new-alias"]).toBeDefined();
    expect(alias["gpt-4o"]).toBeUndefined();
  });

  test("23. PUT with an empty alias clears the stored alias", async () => {
    const res = await req("PUT", "/providers/alias-test", {
      kind: "api",
      id: "alias-test",
      protocol: "openai-compatible",
      baseURL: "https://alias-test.example.com",
      models: ["gpt-4o-upstream", "o3-upstream"],
      alias: {},
    });
    expect(res.status).toBe(200);
    expect(onDisk().providers["alias-test"].alias).toEqual({});
  });

  test("24. POST with alias target not listed in models returns 400 validation failed", async () => {
    const res = await req("POST", "/providers", {
      kind: "api",
      id: "bad-alias-target",
      protocol: "openai-compatible",
      baseURL: "https://bad-alias.example.com",
      models: ["real-model"],
      alias: { "my-alias": { model: "nonexistent-model" } },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation failed");
  });

  test("25. POST with alias variant target not listed in models returns 400 validation failed", async () => {
    const res = await req("POST", "/providers", {
      kind: "api",
      id: "bad-variant-target",
      protocol: "openai-compatible",
      baseURL: "https://bad-variant.example.com",
      models: ["real-model"],
      alias: {
        "my-alias": {
          model: "real-model",
          variants: { thinking: { model: "missing-model" } },
        },
      },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("validation failed");
  });

  test("26. PUT with redacted nested options retains the stored secret", async () => {
    const seed = await req("PUT", "/providers/seed-ai", {
      kind: "ai-sdk",
      id: "seed-ai",
      packageName: "@ai-sdk/openai-compatible",
      options: { headers: { Authorization: "Bearer retained-secret" } },
    });
    expect(seed.status).toBe(200);
    const editView = await req("GET", "/providers/seed-ai/edit-view");
    const { provider } = await editView.json();

    const save = await req("PUT", "/providers/seed-ai", { ...provider, name: "Renamed without secret loss" });

    expect(save.status).toBe(200);
    expect(onDisk().providers["seed-ai"].options).toEqual({
      headers: { Authorization: "Bearer retained-secret" },
    });
  });

  test("27. concurrent POST requests for one id allow exactly one create", async () => {
    const [first, second] = await Promise.all([
      req("POST", "/providers", {
        kind: "api",
        id: "race-create",
        protocol: "openai-compatible",
        baseURL: "https://first.example.com",
      }),
      req("POST", "/providers", {
        kind: "api",
        id: "race-create",
        protocol: "openai-compatible",
        baseURL: "https://second.example.com",
      }),
    ]);

    expect([first.status, second.status].toSorted()).toEqual([201, 409]);
  });

  test("28. concurrent DELETE then PUT does not recreate the deleted provider", async () => {
    const create = await req("POST", "/providers", {
      kind: "api",
      id: "race-update",
      protocol: "openai-compatible",
      baseURL: "https://before.example.com",
    });
    expect(create.status).toBe(201);

    const [removed, updated] = await Promise.all([
      req("DELETE", "/providers/race-update"),
      req("PUT", "/providers/race-update", {
        kind: "api",
        id: "race-update",
        protocol: "openai-compatible",
        baseURL: "https://after.example.com",
      }),
    ]);

    expect(removed.status).toBe(200);
    expect(updated.status).toBe(404);
    expect(onDisk().providers["race-update"]).toBeUndefined();
  });

  test("29. POST ai-sdk provider with a blank packageName returns 400 without writing it", async () => {
    // Given
    const id = "blank-package";

    // When
    const response = await req("POST", "/providers", {
      kind: "ai-sdk",
      id,
      packageName: "   ",
    });

    // Then
    expect(response.status).toBe(400);
    expect(onDisk().providers[id]).toBeUndefined();
  });
});
