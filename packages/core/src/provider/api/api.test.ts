import { ProviderProtocol } from "@aio-proxy/types";
import { describe, expect, test } from "bun:test";

import { createApiProvider } from "./api";

const protocols = [
  ProviderProtocol.OpenAICompatible,
  ProviderProtocol.OpenAIResponse,
  ProviderProtocol.Anthropic,
  ProviderProtocol.Gemini,
] as const;
const credentialHeaders = ["authorization", "proxy-authorization", "cookie", "x-api-key", "x-goog-api-key"];

describe("createApiProvider", () => {
  test.each(protocols)(
    "removes inbound client credentials for %s when no provider key is configured",
    async (protocol) => {
      let seen: Headers | undefined;
      const upstream = Bun.serve({
        port: 0,
        fetch(request) {
          seen = new Headers(request.headers);
          return Response.json({ ok: true });
        },
      });

      try {
        const provider = createApiProvider({
          kind: "api",
          id: "provider",
          protocol,
          baseURL: upstream.url.toString(),
        });
        await provider.passthrough(
          new Request("https://proxy.local/v1/test", {
            headers: {
              authorization: "Bearer client-token",
              "proxy-authorization": "Basic client-proxy-token",
              cookie: "session=client-cookie",
              "x-api-key": "client-anthropic-key",
              "x-goog-api-key": "client-gemini-key",
              "x-custom": "kept",
            },
          }),
        );

        for (const name of credentialHeaders) expect(seen?.get(name)).toBeNull();
        expect(seen?.get("x-custom")).toBe("kept");
      } finally {
        upstream.stop(true);
      }
    },
  );

  test.each([
    [ProviderProtocol.OpenAICompatible, "authorization", "Bearer provider-key"],
    [ProviderProtocol.OpenAIResponse, "authorization", "Bearer provider-key"],
    [ProviderProtocol.Anthropic, "x-api-key", "provider-key"],
    [ProviderProtocol.Gemini, "x-goog-api-key", "provider-key"],
  ] as const)("owns the configured upstream credential for %s", async (protocol, headerName, headerValue) => {
    let seen: Headers | undefined;
    const upstream = Bun.serve({
      port: 0,
      fetch(request) {
        seen = new Headers(request.headers);
        return Response.json({ ok: true });
      },
    });

    try {
      const provider = createApiProvider({
        kind: "api",
        id: "provider",
        protocol,
        baseURL: upstream.url.toString(),
        apiKey: "provider-key",
      });
      await provider.passthrough(
        new Request("https://proxy.local/v1/test", {
          headers: Object.fromEntries(credentialHeaders.map((name) => [name, `client-${name}`])),
        }),
      );

      for (const name of credentialHeaders) {
        expect(seen?.get(name)).toBe(name === headerName ? headerValue : null);
      }
    } finally {
      upstream.stop(true);
    }
  });

  test.each([
    ProviderProtocol.OpenAIResponse,
    ProviderProtocol.OpenAICompatible,
    ProviderProtocol.Anthropic,
    ProviderProtocol.Gemini,
  ] as const)(
    "routes upstream calls through an injected fetch and applies configured headers last for %s",
    async (protocol) => {
      let seenHeaders: Headers | undefined;
      const injectedFetch = (async (_input: unknown, init?: RequestInit) => {
        seenHeaders = new Headers(init?.headers);
        return Response.json({ ok: true });
      }) as typeof globalThis.fetch;

      const provider = createApiProvider(
        {
          kind: "api",
          id: "provider",
          protocol,
          baseURL: "https://upstream.example",
          apiKey: "provider-key",
          headers: {
            Authorization: "Configured authorization",
            Host: "configured-host.example",
            "X-Api-Key": "configured-api-key",
            "X-Goog-Api-Key": "configured-google-key",
            "Accept-Encoding": "configured-encoding",
            "X-Tenant": "team-a",
          },
        },
        { fetch: injectedFetch },
      );

      await provider.passthrough(
        new Request("https://proxy.local/v1/test", {
          headers: {
            authorization: "Bearer client-token",
            "x-api-key": "client-anthropic-key",
            "x-goog-api-key": "client-gemini-key",
            "accept-encoding": "gzip",
            host: "proxy.local",
          },
        }),
      );

      expect(seenHeaders?.get("authorization")).toBe("Configured authorization");
      expect(seenHeaders?.get("host")).toBe("configured-host.example");
      expect(seenHeaders?.get("x-api-key")).toBe("configured-api-key");
      expect(seenHeaders?.get("x-goog-api-key")).toBe("configured-google-key");
      expect(seenHeaders?.get("accept-encoding")).toBe("configured-encoding");
      expect(seenHeaders?.get("x-tenant")).toBe("team-a");
    },
  );

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
        baseURL: upstream.url.toString(),
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
});
