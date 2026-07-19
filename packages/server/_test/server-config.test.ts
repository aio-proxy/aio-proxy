import type { AppType } from "@aio-proxy/server";

import { createServer as createBaseServer, serverDefaults } from "@aio-proxy/server";
import { ConfigSchema } from "@aio-proxy/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hc } from "hono/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  test("GET /dashboard/api/config redacts secret-like config values when requested", async () => {
    // Given
    const app = await createServer({ config });

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
    const app = await createServer({ config });

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
    const app = await createServer({ config });

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

  test("server config rejects non-loopback binding", () => {
    expect(() => ConfigSchema.parse({ server: { host: "0.0.0.0" }, providers: {} })).toThrow();
  });

  test("RPC client exposes typed dashboard config get when constructed", () => {
    // Given / When
    const client = hc<AppType>("http://127.0.0.1:22078");

    // Then
    expect(typeof client.dashboard.api.config.$get).toBe("function");
  });
});
