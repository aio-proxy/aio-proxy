import { describe, expect, test } from "bun:test";
import type { CredentialPort } from "@aio-proxy/plugin-sdk";
import { discoverXAIGrokModels, initialXAIGrokCatalogFallback, XAIGrokCatalogError } from "./catalog";
import type { XAIGrokCredential } from "./schema";

describe("xAI Grok model catalog", () => {
  test("discovers account models and excludes non-chat surfaces", async () => {
    let request: Request | undefined;
    const catalog = await discoverXAIGrokModels(context(), {
      fetch: async (input, init) => {
        request = new Request(input, init);
        return Response.json({
          data: [
            { id: "grok-4.5" },
            { id: "grok-new", name: "Grok New" },
            { id: "grok-imagine-image" },
            { id: "grok-stt-audio" },
            { id: "grok-voice-live" },
            { id: "embedding-model" },
          ],
        });
      },
      now: () => 0,
    });
    expect(request?.url).toBe("https://api.x.ai/v1/models");
    expect(request?.headers.get("authorization")).toBe("Bearer access-token");
    expect(catalog.language).toEqual([
      { id: "grok-4.5", displayName: "Grok 4.5" },
      { id: "grok-new", displayName: "Grok New" },
    ]);
  });

  test("falls back only for retryable discovery failures", () => {
    expect(initialXAIGrokCatalogFallback(new XAIGrokCatalogError("network", true))?.language).toContainEqual({
      id: "grok-build",
      displayName: "Grok Build",
    });
    expect(initialXAIGrokCatalogFallback(new XAIGrokCatalogError("unauthorized", false))).toBeUndefined();
  });

  test("treats a successful empty catalog as authoritative", async () => {
    const catalog = await discoverXAIGrokModels(context(), {
      fetch: async () => Response.json({ data: [] }),
      now: () => 0,
    });
    expect(catalog.language).toEqual([]);
  });
});

function context() {
  return {
    credentials: staticPort(),
    options: {},
    signal: new AbortController().signal,
  };
}

function staticPort(): CredentialPort<XAIGrokCredential> {
  return {
    read: async () => ({
      revision: 1,
      value: { accessToken: "access-token", refreshToken: "refresh", expiresAt: 600_000 },
    }),
    refresh: async () => {
      throw new Error("fresh credential must not refresh");
    },
  };
}
