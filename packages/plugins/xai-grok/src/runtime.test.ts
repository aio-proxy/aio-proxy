import type { CredentialPort, ModelCatalog } from "@aio-proxy/plugin-sdk";

import { describe, expect, test } from "bun:test";

import type { XAIGrokCredential } from "./schema";

import { createXAIGrokDynamicFetch, createXAIGrokRuntime } from "./runtime";

describe("xAI Grok runtime", () => {
  test("exposes Responses language models without raw capability", async () => {
    const runtime = await createXAIGrokRuntime({ credentials: port(), options: {}, catalog: emptyCatalog() });
    expect(runtime.provider.specificationVersion).toBe("v4");
    expect(runtime.provider.languageModel("grok-4.5").modelId).toBe("grok-4.5");
    expect(runtime.raw).toBeUndefined();
  });

  test("injects CLI identity and removes only reasoning.summary", async () => {
    let captured: Request | undefined;
    let observedSignal: AbortSignal | null | undefined;
    const controller = new AbortController();
    const dynamicFetch = createXAIGrokDynamicFetch(port(), {
      fetch: async (input, init) => {
        captured = new Request(input, init);
        observedSignal = init?.signal;
        return new Response(null, { status: 200 });
      },
      now: () => 0,
    });
    await dynamicFetch("https://cli-chat-proxy.grok.com/v1/responses", {
      method: "POST",
      headers: { authorization: "Bearer placeholder", "x-keep": "yes" },
      body: JSON.stringify({ model: "grok-4.5", reasoning: { effort: "high", summary: "auto" } }),
      signal: controller.signal,
    });
    expect(captured?.url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(captured?.headers.get("authorization")).toBe("Bearer access-token");
    expect(captured?.headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(captured?.headers.get("x-grok-client-version")).toBe("0.2.93");
    expect(captured?.headers.get("user-agent")).toBe("xai-grok-workspace/0.2.93");
    expect(captured?.headers.get("x-keep")).toBe("yes");
    expect(await captured?.json()).toEqual({ model: "grok-4.5", reasoning: { effort: "high" } });
    expect(observedSignal).toBe(controller.signal);
  });
});

function port(): CredentialPort<XAIGrokCredential> {
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

function emptyCatalog(): ModelCatalog {
  return { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };
}
