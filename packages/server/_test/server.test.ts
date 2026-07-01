import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppType } from "@aio-proxy/server";
import serverEntrypoint, {
  createServer,
  serverDefaults,
} from "@aio-proxy/server";
import { hc } from "hono/client";
import { createDashboardEventHub } from "../src/dashboard-events";

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

    // Then
    expect(typeof client.dashboard.config.$get).toBe("function");
  });

  test("Given alias collision config reload When reload is requested Then old provider keeps serving", async () => {
    // Given
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-reload-"));
    const configPath = join(dir, "config.jsonc");
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return Response.json({ servedBy: "old-openai" }, { status: 208 });
      },
    });
    const initialConfig = {
      providers: [
        {
          kind: "api",
          id: "old-openai",
          vendor: "openai-native",
          protocol: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}`,
          models: ["gpt-old"],
        },
      ],
    };
    writeFileSync(configPath, `${JSON.stringify(initialConfig)}\n`);
    const app = createServer({
      config: initialConfig,
      configPath,
      watchConfig: false,
    });

    try {
      writeFileSync(
        configPath,
        `${JSON.stringify({
          providers: [
            {
              kind: "api",
              id: "first",
              vendor: "openai-native",
              protocol: "openai-chat",
              baseUrl: "https://first.example.com",
              models: [{ alias: "same", id: "first-model" }],
            },
            {
              kind: "api",
              id: "second",
              vendor: "openai-native",
              protocol: "openai-chat",
              baseUrl: "https://second.example.com",
              models: [{ alias: "same", id: "second-model" }],
            },
          ],
        })}\n`,
      );

      // When
      const reload = await app.request("/dashboard/reload", {
        headers: { Origin: "http://127.0.0.1:22079" },
        method: "POST",
      });
      const chat = await app.request("/v1/chat/completions", {
        body: JSON.stringify({
          model: "gpt-old",
          messages: [{ role: "user", content: "still there" }],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = await chat.json();

      // Then
      expect(reload.status).toBe(409);
      expect(chat.status).toBe(208);
      expect(body).toEqual({ servedBy: "old-openai" });
    } finally {
      await upstream.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Given slow dashboard event consumer When queue overflows Then dropped event is emitted and stream closes", async () => {
    // Given
    const app = createServer({
      config: { providers: [] },
      eventLimits: { maxEvents: 1, maxBytes: 1_024 },
    });
    const stream = await app.request("/dashboard/events");

    // When
    await app.request("/dashboard/reload", {
      headers: { Origin: "http://127.0.0.1:22079" },
      method: "POST",
    });
    await app.request("/dashboard/reload", {
      headers: { Origin: "http://127.0.0.1:22079" },
      method: "POST",
    });
    const text = await stream.text();

    // Then
    expect(stream.status).toBe(200);
    expect(text).toContain("event: events.dropped");
    expect(text).toContain('"queuedEvents":1');
  });

  test("Given configured provider When dashboard providers are requested Then summary and probe status are returned", async () => {
    // Given
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response("", { status: 204 });
      },
    });
    const app = createServer({
      config: {
        providers: [
          {
            kind: "api",
            id: "openai",
            vendor: "openai-native",
            protocol: "openai-chat",
            baseUrl: `http://127.0.0.1:${upstream.port}`,
            models: ["gpt-test"],
          },
        ],
      },
    });

    try {
      // When
      const list = await app.request("/dashboard/providers");
      const probe = await app.request(
        "/dashboard/providers?probe=true&filter=openai",
      );

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
    } finally {
      await upstream.stop(true);
    }
  });

  test("Given many trace deltas for one trace When events flush Then only latest delta is emitted", async () => {
    // Given
    const hub = createDashboardEventHub();
    const stream = new Response(hub.stream());

    // When
    hub.publish({
      event: "trace.delta",
      data: { trace_id: "trace-1", textDelta: "first" },
    });
    hub.publish({
      event: "trace.delta",
      data: { trace_id: "trace-1", textDelta: "second" },
    });
    await Bun.sleep(70);
    hub.close();
    const text = await stream.text();

    // Then
    expect(text).not.toContain("first");
    expect(text).toContain("second");
  });
});
