import { parseRuntimeConfig } from "@aio-proxy/core";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { disabledDashboardAuthentication } from "../dashboard-auth/test-support";
import { createServerState } from "../server-state";
import { createDashboardRoutes } from "./config";

const authoredConfig = {
  proxy: "{{env.GLOBAL_PROXY}}",
  providers: {
    api: {
      kind: "api",
      protocol: "openai-response",
      baseURL: "{{env.API_BASE_URL}}",
      apiKey: "sk-preserved-value",
      proxy: "{{env.PROVIDER_PROXY}}",
      headers: { Authorization: "Bearer {{env.UPSTREAM_TOKEN}}", "X-Tenant": "{{env.TENANT}}" },
      models: ["gpt-test"],
      enabled: true,
    },
    sdk: {
      kind: "ai-sdk",
      packageName: "@ai-sdk/openai-compatible",
      proxy: "{{env.SDK_PROXY}}",
      options: { name: "sdk", apiKey: "sk-sdk", baseURL: "https://sdk.example" },
      models: ["sdk-model"],
      enabled: true,
    },
  },
};

async function withNetworkFixture(
  run: (routes: ReturnType<typeof createDashboardRoutes>, configPath: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "aio-dashboard-network-"));
  const configPath = join(dir, "config.json");
  writeFileSync(configPath, JSON.stringify(authoredConfig, null, 2));

  const previous = {
    GLOBAL_PROXY: process.env["GLOBAL_PROXY"],
    API_BASE_URL: process.env["API_BASE_URL"],
    PROVIDER_PROXY: process.env["PROVIDER_PROXY"],
    UPSTREAM_TOKEN: process.env["UPSTREAM_TOKEN"],
    TENANT: process.env["TENANT"],
    SDK_PROXY: process.env["SDK_PROXY"],
  };
  process.env["GLOBAL_PROXY"] = "http://user:password@global.proxy:8080";
  process.env["API_BASE_URL"] = "https://api.example/v1";
  process.env["PROVIDER_PROXY"] = "http://user:password@provider.proxy:8080";
  process.env["UPSTREAM_TOKEN"] = "expanded-secret";
  process.env["TENANT"] = "expanded-tenant";
  process.env["SDK_PROXY"] = "http://user:password@sdk.proxy:8080";

  const state = await createServerState({
    config: parseRuntimeConfig(authoredConfig),
    configPath,
    watchConfig: false,
  });
  const routes = createDashboardRoutes(state, disabledDashboardAuthentication);

  try {
    await run(routes, configPath);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function onDisk(configPath: string) {
  return JSON.parse(readFileSync(configPath, "utf8")) as typeof authoredConfig;
}

test("GET /config and edit-view redact proxy credentials and header values", async () => {
  await withNetworkFixture(async (routes) => {
    const configResponse = await routes.request("/config");
    expect(configResponse.status).toBe(200);
    const configText = await configResponse.text();
    expect(configText).not.toMatch(/user:password|expanded-secret|expanded-tenant/u);
    expect(configText).toMatch(/"proxy"\s*:\s*"\*\*\*\*"/u);

    const editResponse = await routes.request("/providers/api/edit-view");
    expect(editResponse.status).toBe(200);
    const editText = await editResponse.text();
    expect(editText).not.toMatch(/user:password|expanded-secret|expanded-tenant/u);
    expect(editText).toMatch(/"proxy"\s*:\s*"\*\*\*\*"/u);
    expect(editText).toMatch(/"Authorization"\s*:\s*"\*\*\*\*"/u);
  });
});

test("unrelated provider edits retain omitted headers and proxy", async () => {
  await withNetworkFixture(async (routes, configPath) => {
    const response = await routes.request("/providers/api", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "api",
        id: "api",
        protocol: "openai-response",
        baseURL: "https://api.example/v1",
        weight: 7,
        models: ["gpt-test"],
        enabled: true,
      }),
    });
    expect(response.status).toBe(200);

    const disk = onDisk(configPath);
    expect(disk.providers.api.proxy).toBe("{{env.PROVIDER_PROXY}}");
    expect(disk.providers.api.headers).toEqual({
      Authorization: "Bearer {{env.UPSTREAM_TOKEN}}",
      "X-Tenant": "{{env.TENANT}}",
    });
    expect(disk.providers.api.baseURL).toBe("{{env.API_BASE_URL}}");
    expect((disk.providers.api as { weight?: number }).weight).toBe(7);
  });
});

test("submitting **** retains raw proxy and header templates", async () => {
  await withNetworkFixture(async (routes, configPath) => {
    const response = await routes.request("/providers/api", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "api",
        id: "api",
        protocol: "openai-response",
        baseURL: "https://api.example/v1",
        proxy: "****",
        headers: { Authorization: "****", "X-Tenant": "****" },
        models: ["gpt-test"],
        enabled: true,
      }),
    });
    expect(response.status).toBe(200);

    const disk = onDisk(configPath);
    expect(disk.providers.api.proxy).toBe("{{env.PROVIDER_PROXY}}");
    expect(disk.providers.api.headers).toEqual({
      Authorization: "Bearer {{env.UPSTREAM_TOKEN}}",
      "X-Tenant": "{{env.TENANT}}",
    });
  });
});

test("submitting the expanded baseURL retains the authored template", async () => {
  await withNetworkFixture(async (routes, configPath) => {
    const response = await routes.request("/providers/api", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "api",
        id: "api",
        protocol: "openai-response",
        baseURL: "https://api.example/v1",
        models: ["gpt-test"],
        enabled: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(onDisk(configPath).providers.api.baseURL).toBe("{{env.API_BASE_URL}}");
  });
});

test("malformed template or expanded SOCKS proxy returns 422 without altering the file", async () => {
  await withNetworkFixture(async (routes, configPath) => {
    const before = readFileSync(configPath, "utf8");

    const malformed = await routes.request("/providers/api", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "api",
        id: "api",
        protocol: "openai-response",
        baseURL: "{{env.API_BASE_URL}}{{#if true}}x{{/if}}",
        models: ["gpt-test"],
        enabled: true,
      }),
    });
    expect(malformed.status).toBe(422);
    expect(readFileSync(configPath, "utf8")).toBe(before);

    process.env["PROVIDER_PROXY"] = "socks://proxy.example:1080";
    const socks = await routes.request("/providers/api", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "api",
        id: "api",
        protocol: "openai-response",
        baseURL: "https://api.example/v1",
        proxy: "{{env.PROVIDER_PROXY}}",
        models: ["gpt-test"],
        enabled: true,
      }),
    });
    expect(socks.status).toBe(422);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });
});
