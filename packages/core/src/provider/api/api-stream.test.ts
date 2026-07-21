import { ProviderProtocol } from "@aio-proxy/types";
import { describe, expect, test } from "bun:test";

import type { ApiProviderTrace } from "./api";

import { createApiProvider } from "./api";

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

describe("createApiProvider streaming and trace behavior", () => {
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
        baseURL: upstream.url.toString(),
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
        baseURL: upstream.url.toString(),
      });

      const response = await provider.passthrough(new Request("https://proxy.local/v1/chat/completions"));

      expect(response.headers.get("content-encoding")).toBeNull();
      expect(response.headers.get("content-length")).toBeNull();
      expect(await response.text()).toBe(body);
    } finally {
      upstream.stop(true);
    }
  });

  test("preserves request encoding while stripping decoded zstd response headers", async () => {
    const body = JSON.stringify({ ok: true });
    const compressed = Bun.zstdCompressSync(new TextEncoder().encode(body));
    const upstream = Bun.serve({
      port: 0,
      fetch(req) {
        expect(req.headers.get("accept-encoding")).toBe("gzip, deflate, br, zstd");
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
        baseURL: upstream.url.toString(),
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
        baseURL: upstream.url.toString(),
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
