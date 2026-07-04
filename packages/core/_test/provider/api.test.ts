import { describe, expect, test } from "bun:test";
import { ProviderProtocol } from "@aio-proxy/types";
import type { ApiProviderTrace } from "../../src/index";
import { createApiProvider } from "../../src/index";

async function sha256Text(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function waitForTrace(trace: readonly ApiProviderTrace[]): Promise<ApiProviderTrace> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const first = trace[0];
    if (first !== undefined) {
      return first;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error("trace was not recorded");
}

describe("createApiProvider", () => {
  test("preserves non-stream request bytes, path, query, and rewrites auth", async () => {
    let seen:
      | {
          readonly authorization: string | null;
          readonly body: string;
          readonly encoding: string | null;
          readonly forwardedBy: string | null;
          readonly host: string | null;
          readonly method: string;
          readonly pathname: string;
          readonly query: string;
          readonly xCustom: string | null;
        }
      | undefined;
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        seen = {
          authorization: req.headers.get("authorization"),
          body: await req.text(),
          encoding: req.headers.get("accept-encoding"),
          forwardedBy: req.headers.get("x-forwarded-by"),
          host: req.headers.get("host"),
          method: req.method,
          pathname: url.pathname,
          query: url.search,
          xCustom: req.headers.get("x-custom"),
        };

        return Response.json({ ok: true });
      },
    });

    process.env.AIO_PROXY_TEST_KEY = "env-secret";
    try {
      const provider = createApiProvider({
        kind: "api",
        id: "openai",
        protocol: ProviderProtocol.OpenAICompatible,
        baseUrl: upstream.url.toString(),
        apiKey: "$AIO_PROXY_TEST_KEY",
        models: ["gpt-5-mini"],
      });

      const response = await provider.passthrough(
        new Request("https://proxy.local/v1/chat/completions?a=1&b=two", {
          body: '{"model":"gpt-5-mini"}',
          headers: {
            authorization: "Bearer old",
            "accept-encoding": "gzip",
            host: "proxy.local",
            "content-type": "application/json",
            "x-custom": "kept",
          },
          method: "POST",
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(seen).toEqual({
        authorization: "Bearer env-secret",
        body: '{"model":"gpt-5-mini"}',
        encoding: "identity",
        forwardedBy: "aio-proxy/0.0.0",
        host: upstream.url.host,
        method: "POST",
        pathname: "/v1/chat/completions",
        query: "?a=1&b=two",
        xCustom: "kept",
      });
    } finally {
      delete process.env.AIO_PROXY_TEST_KEY;
      upstream.stop(true);
    }
  });

  test("passes SSE stream bytes through unchanged and records response hash", async () => {
    const body = Array.from({ length: 50 }, (_, index) => `data: chunk-${index}\n\n`).join("");
    const expectedHash = await sha256Text(body);
    const trace: ApiProviderTrace[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(body, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });

    try {
      const provider = createApiProvider({
        kind: "api",
        id: "openai",
        protocol: ProviderProtocol.OpenAICompatible,
        baseUrl: upstream.url.toString(),
        apiKey: "direct-key",
        trace,
      });

      const response = await provider.passthrough(new Request("https://proxy.local/v1/chat/completions?stream=true"));

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
      expect(await waitForTrace(trace)).toEqual({
        bodySha256: expectedHash,
        category: undefined,
        status: 200,
      });
    } finally {
      upstream.stop(true);
    }
  });

  test("strips upstream decompression headers from decoded responses", async () => {
    const body = JSON.stringify({ ok: true });
    const compressed = Bun.gzipSync(new TextEncoder().encode(body));
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response(compressed, {
          headers: {
            "content-encoding": "gzip",
            "content-length": String(compressed.byteLength),
            "content-type": "application/json",
          },
        });
      },
    });

    try {
      const provider = createApiProvider({
        kind: "api",
        id: "openai",
        protocol: ProviderProtocol.OpenAICompatible,
        baseUrl: upstream.url.toString(),
      });

      const response = await provider.passthrough(new Request("https://proxy.local/v1/chat/completions"));

      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("content-length")).toBeNull();
      expect(await response.text()).toBe(body);
    } finally {
      upstream.stop(true);
    }
  });

  test("strips zstd headers when upstream ignores identity encoding", async () => {
    const body = JSON.stringify({ ok: true });
    const compressed = Bun.zstdCompressSync(new TextEncoder().encode(body));
    const upstream = Bun.serve({
      port: 0,
      fetch(req) {
        expect(req.headers.get("accept-encoding")).toBe("identity");
        return new Response(compressed, {
          headers: {
            "content-encoding": "zstd",
            "content-length": String(compressed.byteLength),
            "content-type": "application/json",
          },
        });
      },
    });

    try {
      const provider = createApiProvider({
        kind: "api",
        id: "openai",
        protocol: ProviderProtocol.OpenAICompatible,
        baseUrl: upstream.url.toString(),
      });

      const response = await provider.passthrough(
        new Request("https://proxy.local/v1/chat/completions", {
          headers: { "accept-encoding": "gzip, deflate, br, zstd" },
        }),
      );

      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("content-length")).toBeNull();
      expect(await response.text()).toBe(body);
    } finally {
      upstream.stop(true);
    }
  });

  test("surfaces upstream 429 and records rate_limit trace category", async () => {
    const trace: ApiProviderTrace[] = [];
    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response("slow down", { status: 429 });
      },
    });

    try {
      const provider = createApiProvider({
        kind: "api",
        id: "openai",
        protocol: ProviderProtocol.OpenAICompatible,
        baseUrl: upstream.url.toString(),
        trace,
      });

      const response = await provider.passthrough(new Request("https://proxy.local/v1/chat/completions"));

      expect(response.status).toBe(429);
      expect(await response.text()).toBe("slow down");
      expect(await waitForTrace(trace)).toEqual({
        bodySha256: await sha256Text("slow down"),
        category: "rate_limit",
        status: 429,
      });
    } finally {
      upstream.stop(true);
    }
  });
});
