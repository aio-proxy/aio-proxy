import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AiSdkProviderInstance } from "@aio-proxy/core";
import { createServer } from "@aio-proxy/server";

import {
  chatRequest,
  createTempHomes,
  mockModelsDevCatalog,
  recorded,
  restoreFetch,
  textStream,
  waitForUsageRow,
} from "./openai-completions.test-support";

beforeEach(mockModelsDevCatalog);
afterEach(restoreFetch);
const homes = createTempHomes("aio-proxy-openai-usage-");
const tempHome = homes.tempHome;
afterEach(homes.cleanup);

describe("POST /v1/chat/completions", () => {
  test("Given ai-sdk provider When non-stream completion is posted Then OpenAI JSON is returned", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        return textStream([
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", text: "Hel" },
          { type: "text-delta", id: "text-1", text: "lo" },
          { type: "text-end", id: "text-1" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body.id).toStartWith("chatcmpl-");
    expect(body.id).not.toContain("aio-proxy");
    expect(body).toMatchObject({
      object: "chat.completion",
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          logprobs: null,
          message: { role: "assistant", content: "Hello", refusal: null },
        },
      ],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
      },
    });
  });

  test("Given a slow price catalog When non-stream completion finishes Then the client response is not blocked", async () => {
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        return textStream([
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", text: "Hello" },
          { type: "text-end", id: "text-1" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });
    const originalFetch = globalThis.fetch;
    const catalogResponse = Promise.withResolvers<Response>();
    const catalogRequested = Promise.withResolvers<void>();
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://models.dev/api.json") {
        catalogRequested.resolve();
        return catalogResponse.promise;
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      let responseResolved = false;
      const responseTask = app
        .request("/v1/chat/completions", {
          body: JSON.stringify({ ...chatRequest, stream: false }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
        .then((response) => {
          responseResolved = true;
          return response;
        });

      await catalogRequested.promise;
      await Bun.sleep(0);
      expect(responseResolved).toBe(true);

      catalogResponse.resolve(Response.json({ openrouter: { models: {} } }));
      expect((await responseTask).status).toBe(200);
      expect(await recorded(dbHome)).toEqual({
        requests: [expect.objectContaining({ outcome: "success" })],
        usages: [expect.objectContaining({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })],
      });
    } finally {
      catalogResponse.resolve(Response.json({ openrouter: { models: {} } }));
      globalThis.fetch = originalFetch;
    }
  });

  test("Given ai-sdk provider returns usage When completion finishes Then dashboard overview includes it", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        return textStream([
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", text: "Hel" },
          { type: "text-delta", id: "text-1", text: "lo" },
          { type: "text-end", id: "text-1" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: {
              inputTokenDetails: {
                noCacheTokens: undefined,
                cacheReadTokens: undefined,
                cacheWriteTokens: undefined,
              },
              inputTokens: 3,
              outputTokenDetails: {
                textTokens: undefined,
                reasoningTokens: undefined,
              },
              outputTokens: 2,
              totalTokens: 5,
            },
          },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      dbHome: tempHome(),
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await response.text();

    // Then
    expect(await waitForUsageRow(app)).toEqual({
      range: "24h",
      metric: "tokens",
      groupBy: "provider",
      rangeStart: expect.any(String),
      rangeEnd: expect.any(String),
      bucketUnit: "hour",
      summary: expect.objectContaining({
        inputTokens: 3,
        outputTokens: 2,
        requestCount: 1,
        totalTokens: 5,
      }),
      series: [{ key: "mock-ai", kind: "dimension" }],
      buckets: expect.any(Array),
    });
  });

  test("Given ai-sdk provider When stream is omitted Then OpenAI JSON is returned", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        return textStream([
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", text: "Hello" },
          { type: "text-end", id: "text-1" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ model: chatRequest.model, messages: chatRequest.messages }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Hello");
  });
});
