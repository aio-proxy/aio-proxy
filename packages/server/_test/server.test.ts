import { describe, expect, test } from "bun:test";
import type { AppType } from "@aio-proxy/server";
import serverEntrypoint, {
  createServer,
  serverDefaults,
} from "@aio-proxy/server";
import { hc } from "hono/client";

const config = {
  providers: [
    {
      kind: "api",
      vendor: "openai-native",
      protocol: "openai-chat",
      apiKey: "sk-abcdefghijklmnopqrstuvwxyz",
      baseUrl: "https://api.example.com",
      models: ["gpt-test"],
    },
    {
      kind: "api",
      vendor: "openai-compatible",
      protocol: "openai-chat",
      apiKey: "Bearer super-secret-token",
      baseUrl: "https://compatible.example.com",
      models: ["compatible-test"],
    },
  ],
};

describe("server routes", () => {
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

  test("GET /dashboard/config redacts secret-like config values when requested", async () => {
    // Given
    const app = createServer({ config });

    // When
    const response = await app.request("/dashboard/config");
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(body)).not.toContain("super-secret-token");
    expect(body.providers[0].apiKey).toBe("sk-****");
    expect(body.providers[1].apiKey).toBe("Bearer ****");
  });

  test("POST /dashboard/config rejects evil origin when requested", async () => {
    // Given
    const app = createServer({ config });

    // When
    const response = await app.request("/dashboard/config", {
      method: "POST",
      headers: { Origin: "http://evil.example" },
    });

    // Then
    expect(response.status).toBe(403);
  });

  test("POST /dashboard/config rejects absent origin when requested", async () => {
    // Given
    const app = createServer({ config });

    // When
    const response = await app.request("/dashboard/config", { method: "POST" });

    // Then
    expect(response.status).toBe(403);
  });

  test("server defaults bind to localhost dashboard port when inspected", () => {
    // Given / When / Then
    expect(serverDefaults).toEqual({ host: "127.0.0.1", port: 22_078 });
  });

  test("Bun entrypoint binds localhost dashboard port when inspected", () => {
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
    const request = client.dashboard.config.$get();

    // Then
    expect(request).toBeInstanceOf(Promise);
  });
});
