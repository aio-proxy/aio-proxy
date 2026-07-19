import { afterAll, describe, expect, test } from "bun:test";

import { createDashboardProviderFixture } from "./dashboard-providers-mutation.test-support";

const { cleanup, onDisk, req } = await createDashboardProviderFixture("aio-dashboard-provider-aliases-");

afterAll(cleanup);

describe("dashboard provider CRUD", () => {
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
});
