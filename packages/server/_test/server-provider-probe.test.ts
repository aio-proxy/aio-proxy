import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createBaseServer } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";

import { config } from "./server.test-support";

describe("server routes", () => {
  let dir: string;
  const createServer = (options: Parameters<typeof createBaseServer>[0]) =>
    createBaseServer({ ...options, dbHome: dir });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aio-proxy-server-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
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
    const app = await createServer({
      config: {
        providers: {
          openai: {
            kind: "api",
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: `http://127.0.0.1:${upstream.port}`,
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
            clientModels: ["gpt-test"],
            hasApiKey: false,
            state: { status: "ready" },
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

  test("Given an API key When a provider is probed Then the upstream request is authenticated", async () => {
    let authorization: string | null = null;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        authorization = request.headers.get("authorization");
        return new Response("", { status: 204 });
      },
    });
    const app = await createServer({
      config: {
        providers: {
          authenticated: {
            kind: "api",
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: `http://127.0.0.1:${upstream.port}`,
            apiKey: "probe-secret",
            models: ["gpt-test"],
          },
        },
      },
    });

    try {
      await app.request("/dashboard/api/providers?probe=true&filter=authenticated");
      expect(authorization).toBe("Bearer probe-secret");
    } finally {
      await upstream.stop(true);
    }
  });

  test("Given configured models When a provider is probed Then the first real model is used", async () => {
    let model: unknown;
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = await request.json();
        model = typeof body === "object" && body !== null && "model" in body ? body.model : undefined;
        return new Response("", { status: 204 });
      },
    });
    const app = await createServer({
      config: {
        providers: {
          configured: {
            kind: "api",
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: `http://127.0.0.1:${upstream.port}`,
            models: ["gpt-real", "gpt-fallback"],
          },
        },
      },
    });

    try {
      await app.request("/dashboard/api/providers?probe=true&filter=configured");
      expect(model).toBe("gpt-real");
    } finally {
      await upstream.stop(true);
    }
  });

  test("Given completion API providers When probed Then generated output is capped per protocol", async () => {
    // Given
    const requests = new Map<string, unknown>();
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        requests.set(new URL(request.url).pathname, await request.json());
        return new Response("", { status: 204 });
      },
    });
    const baseURL = `http://127.0.0.1:${upstream.port}`;
    const app = await createServer({
      config: {
        providers: {
          chat: {
            kind: "api",
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL,
            models: ["chat-model"],
          },
          responses: {
            kind: "api",
            protocol: ProviderProtocol.OpenAIResponse,
            baseURL,
            models: ["responses-model"],
          },
          gemini: {
            kind: "api",
            protocol: ProviderProtocol.Gemini,
            baseURL,
            models: ["gemini-model"],
          },
        },
      },
    });

    try {
      // When
      await app.request("/dashboard/api/providers?probe=true&filter=chat");
      await app.request("/dashboard/api/providers?probe=true&filter=responses");
      await app.request("/dashboard/api/providers?probe=true&filter=gemini");

      // Then
      expect(requests.get("/v1/chat/completions")).toMatchObject({ max_tokens: 1 });
      expect(requests.get("/v1/responses")).toMatchObject({ max_output_tokens: 16 });
      expect(requests.get("/v1beta/models/gemini-model:generateContent")).toMatchObject({
        generationConfig: { maxOutputTokens: 1 },
      });
    } finally {
      await upstream.stop(true);
    }
  });

  test("Given configured provider When dashboard provider detail is requested Then one provider is returned", async () => {
    // Given
    const app = await createServer({ config });

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
        clientModels: ["gpt-alias", "gpt-test"],
        hasApiKey: true,
        state: { status: "ready" },
      },
    });
    expect(missing.status).toBe(404);
  });
});
