import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Auth, OPENAI_CHATGPT_MODELS } from "@aio-proxy/oauth";
import type { AppType } from "@aio-proxy/server";
import serverEntrypoint, { createServer, serverDefaults } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";
import { hc } from "hono/client";

const config = {
  providers: {
    "openai-compatible": {
      kind: "api",
      protocol: ProviderProtocol.OpenAICompatible,
      apiKey: "sk-abcdefghijklmnopqrstuvwxyz",
      baseUrl: "https://api.example.com",
      models: ["gpt-test"],
      alias: {
        "gpt-alias": { model: "gpt-test", preserve: true },
      },
    },
    compatible: {
      kind: "ai-sdk",
      packageName: "@ai-sdk/openai-compatible",
      options: {
        apiKey: "Bearer super-secret-token",
        baseURL: "https://compatible.example.com",
        headers: {
          authorization: "Token provider-secret",
          "x-api-key": "header-secret",
        },
        name: "compatible",
      },
      models: ["compatible-test"],
      alias: {
        compatible: { model: "compatible-test", preserve: false },
      },
    },
  },
};

describe("server routes", () => {
  let dir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.AIO_PROXY_HOME;
    dir = mkdtempSync(join(tmpdir(), "aio-proxy-server-"));
    process.env.AIO_PROXY_HOME = dir;
  });

  afterEach(() => {
    Auth.del("openai-chatgpt", "chatgpt-xxx");
    if (previousHome === undefined) {
      delete process.env.AIO_PROXY_HOME;
    } else {
      process.env.AIO_PROXY_HOME = previousHome;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  test("GET /health returns ok status and version when requested", async () => {
    // Given
    const app = createServer({ config });

    // When
    const response = await app.request("/health");
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "ok" });
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.version).toBe("string");
  });

  test("Given configured providers When OpenAI models are requested Then model list is returned", async () => {
    // Given
    const app = createServer({ config });

    // When
    const response = await app.request("/v1/models");
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body).toEqual({
      object: "list",
      data: [
        { id: "gpt-alias", object: "model", owned_by: "openai-compatible" },
        { id: "gpt-test", object: "model", owned_by: "openai-compatible" },
        { id: "compatible", object: "model", owned_by: "compatible" },
      ],
    });
  });

  test("Given api provider with models-only and no alias When OpenAI models are requested Then no models are listed", async () => {
    // Given
    const app = createServer({
      config: {
        providers: {
          openai: {
            kind: "api",
            protocol: ProviderProtocol.OpenAICompatible,
            baseUrl: "https://api.openai.com/v1",
            models: ["gpt-5.5", "gpt-5.4"],
          },
        },
      },
    });

    // When
    const response = await app.request("/v1/models");

    // Then
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ object: "list", data: [] });
  });

  test("Given chatgpt oauth provider When OpenAI models are requested Then vendor models are listed via derived alias", async () => {
    // Given
    Auth.set("openai-chatgpt", "chatgpt-xxx", {
      access: "tok",
      refresh: "r",
      expires: Date.now() + 60_000,
      accountId: "xxx",
      models: OPENAI_CHATGPT_MODELS,
    });
    const app = createServer({
      config: { providers: { "chatgpt-xxx": { kind: "oauth", vendor: "openai-chatgpt" } } },
    });

    // When
    const response = await app.request("/v1/models");
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    const ids = (body.data as Array<{ id: string }>).map((model) => model.id);
    expect(ids).toContain("gpt-5.5");
    expect(ids).toContain("gpt-5.4");
  });

  test("Given disabled provider When models and dashboard are requested Then provider is not routed", async () => {
    // Given
    const app = createServer({
      config: {
        providers: {
          openai: {
            kind: "api",
            enabled: false,
            protocol: ProviderProtocol.OpenAICompatible,
            baseUrl: "https://api.example.com",
            models: ["gpt-disabled"],
          },
        },
      },
    });

    // When
    const models = await app.request("/v1/models");
    const providers = await app.request("/dashboard/api/providers");

    // Then
    expect(await models.json()).toEqual({ object: "list", data: [] });
    expect(await providers.json()).toEqual({
      providers: [
        {
          id: "openai",
          kind: "api",
          enabled: false,
          passthrough: true,
          last_status: "unknown",
          last_latency: null,
        },
      ],
    });
  });

  test("GET /dashboard/api/config redacts secret-like config values when requested", async () => {
    // Given
    const app = createServer({ config });

    // When
    const response = await app.request("/dashboard/api/config");
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(body)).not.toContain("super-secret-token");
    expect(JSON.stringify(body)).not.toContain("provider-secret");
    expect(JSON.stringify(body)).not.toContain("header-secret");
    expect(body.providers[0].apiKey).toBe("sk-****");
    expect(body.providers[1].options.apiKey).toBe("****");
    expect(body.providers[1].options.headers.authorization).toBe("****");
    expect(body.providers[1].options.headers["x-api-key"]).toBe("****");
  });

  test("POST /dashboard/api/config rejects evil origin when requested", async () => {
    // Given
    const app = createServer({ config });

    // When
    const response = await app.request("/dashboard/api/config", {
      method: "POST",
      headers: { Origin: "http://evil.example" },
    });

    // Then
    expect(response.status).toBe(403);
  });

  test("POST /dashboard/api/config rejects absent origin when requested", async () => {
    // Given
    const app = createServer({ config });

    // When
    const response = await app.request("/dashboard/api/config", {
      method: "POST",
    });

    // Then
    expect(response.status).toBe(403);
  });

  test("server defaults bind to localhost api port when inspected", () => {
    // Given / When / Then
    expect(serverDefaults).toEqual({ host: "127.0.0.1", port: 22_078 });
  });

  test("Bun entrypoint binds localhost api port when inspected", () => {
    // Given / When / Then
    expect(serverEntrypoint).toMatchObject({
      hostname: serverDefaults.host,
      port: serverDefaults.port,
    });
    expect(typeof serverEntrypoint.fetch).toBe("function");
  });

  test("RPC client exposes typed dashboard config get when constructed", () => {
    // Given / When
    const client = hc<AppType>("http://127.0.0.1:22078");

    // Then
    expect(typeof client.dashboard.api.config.$get).toBe("function");
  });

  test("Given configured provider When dashboard providers are requested Then summary and probe status are returned", async () => {
    // Given
    let pathSeen = "";
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        pathSeen = new URL(request.url).pathname;
        return new Response("", { status: 204 });
      },
    });
    const app = createServer({
      config: {
        providers: {
          openai: {
            kind: "api",
            protocol: ProviderProtocol.OpenAICompatible,
            baseUrl: `http://127.0.0.1:${upstream.port}`,
            models: ["gpt-test"],
          },
        },
      },
    });

    try {
      // When
      const list = await app.request("/dashboard/api/providers");
      const probe = await app.request("/dashboard/api/providers?probe=true&filter=openai");

      // Then
      expect(list.status).toBe(200);
      expect(await list.json()).toEqual({
        providers: [
          {
            id: "openai",
            kind: "api",
            enabled: true,
            passthrough: true,
            last_status: "unknown",
            last_latency: null,
          },
        ],
      });
      const probeBody = await probe.json();
      expect(probe.status).toBe(200);
      expect(probeBody.providers[0].probe).toBe("OK");
      expect(probeBody.providers[0].last_status).toBe("OK");
      expect(typeof probeBody.providers[0].last_latency).toBe("number");
      expect(pathSeen).toBe("/v1/chat/completions");
    } finally {
      await upstream.stop(true);
    }
  });

  test("Given configured provider When dashboard provider detail is requested Then one provider is returned", async () => {
    // Given
    const app = createServer({ config });

    // When
    const found = await app.request("/dashboard/api/providers/openai-compatible");
    const missing = await app.request("/dashboard/api/providers/missing");

    // Then
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({
      provider: {
        id: "openai-compatible",
        kind: "api",
        enabled: true,
        passthrough: true,
        last_status: "unknown",
        last_latency: null,
      },
    });
    expect(missing.status).toBe(404);
  });

  test("Given dashboard install request without confirmation When posted Then request is rejected", async () => {
    // Given
    const app = createServer({ config });

    // When
    const response = await app.request("/dashboard/api/providers/install", {
      body: JSON.stringify({ npm: "aio-proxy-test-provider" }),
      headers: {
        "content-type": "application/json",
        Origin: "http://127.0.0.1:22078",
      },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(400);
    expect(body.error).toContain("confirmed: true");
  });

  test("Given dashboard install request with invalid package name When posted Then request is rejected", async () => {
    // Given
    const app = createServer({ config });

    // When
    const response = await app.request("/dashboard/api/providers/install", {
      body: JSON.stringify({ npm: "../bad", confirmed: true }),
      headers: {
        "content-type": "application/json",
        Origin: "http://127.0.0.1:22078",
      },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(400);
    expect(body.error).toContain("Invalid npm package name");
  });

  test("Given dashboard install request fails at registry When posted Then controlled error is returned", async () => {
    // Given
    const app = createServer({ config });

    // When
    const response = await app.request("/dashboard/api/providers/install", {
      body: JSON.stringify({
        npm: "aio-proxy-dashboard-missing-package",
        confirmed: true,
        registry: "http://127.0.0.1:9",
      }),
      headers: {
        "content-type": "application/json",
        Origin: "http://127.0.0.1:22078",
      },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(502);
    expect(body.error).toContain("Runtime install failed");
  });

  test("Given upstream HTTP 500 When provider is probed Then dashboard reports failure", async () => {
    // Given
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ error: "upstream failed" }, { status: 500 });
      },
    });
    const app = createServer({
      config: {
        providers: {
          bad: {
            kind: "api",
            protocol: ProviderProtocol.OpenAICompatible,
            baseUrl: `http://127.0.0.1:${upstream.port}`,
            models: ["gpt-test"],
          },
        },
      },
    });

    try {
      // When
      const probe = await app.request("/dashboard/api/providers?probe=true&filter=bad");
      const body = await probe.json();

      // Then
      expect(probe.status).toBe(200);
      expect(body.providers[0].probe).toBe("FAIL");
      expect(body.providers[0].last_status).toBe("FAIL");
      expect(typeof body.providers[0].last_latency).toBe("number");
    } finally {
      await upstream.stop(true);
    }
  });
});
