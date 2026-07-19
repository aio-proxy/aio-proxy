import { createServer as createBaseServer } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
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

  test("Given dashboard install request without confirmation When posted Then request is rejected", async () => {
    // Given
    const app = await createServer({ config });

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
    expect(body).toEqual({
      code: "confirmation_required",
      error: "provider install requires confirmation",
    });
  });

  test("Given dashboard install request with invalid package name When posted Then request is rejected", async () => {
    // Given
    const app = await createServer({ config });

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
    const app = await createServer({ config });

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
    const app = await createServer({
      config: {
        providers: {
          bad: {
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
