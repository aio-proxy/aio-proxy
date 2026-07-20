import type { OpenRouterPriceCatalog, TextStreamPart, ToolSet } from "@aio-proxy/core";

import { ProviderProtocol } from "@aio-proxy/types";
import { describe, expect, test } from "bun:test";

import { createUsageCapture } from "./index";
import { drain, textStream } from "./test-support";

describe("usage capture pricing", () => {
  test("passthrough preserves response metadata and bytes while parsing and pricing usage", async () => {
    const body = JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    const catalog: OpenRouterPriceCatalog = {
      find: () => ({ id: "priced/model", input: 2, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
    };
    const captured = createUsageCapture({
      priceCatalogTask: async () => catalog,
    }).passthrough({
      response: new Response(body, {
        headers: { "content-type": "application/json", "x-upstream": "yes" },
        status: 200,
        statusText: "Good",
      }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "model",
    });

    expect(captured.value.status).toBe(200);
    expect(captured.value.statusText).toBe("Good");
    expect(captured.value.headers.get("x-upstream")).toBe("yes");
    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({
      outcome: "success",
      statusCode: 200,
      usage: expect.objectContaining({
        inputTokens: 3,
        outputTokens: 2,
        priceModelId: "priced/model",
        estimatedCostUsd: expect.closeTo(0.000026),
      }),
    });
  });

  test("ai-sdk Gemini-shaped usage does not double-count unpriced thoughts", async () => {
    const catalog: OpenRouterPriceCatalog = {
      find: () => ({ id: "google/gemini", input: 1, output: 2 }),
    };
    const finish: TextStreamPart<ToolSet> = {
      type: "finish",
      finishReason: "stop",
      rawFinishReason: "stop",
      totalUsage: {
        inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined, noCacheTokens: 10 },
        inputTokens: 10,
        outputTokenDetails: { reasoningTokens: 50, textTokens: 100 },
        outputTokens: 150,
        totalTokens: 160,
      },
    };
    const captured = createUsageCapture({ priceCatalogTask: async () => catalog }).stream({
      providerId: "provider",
      modelId: "gemini",
      stream: textStream([finish]),
    });
    await drain(captured.value);
    await expect(captured.completion).resolves.toEqual({
      outcome: "success",
      usage: expect.objectContaining({
        inputTokens: 10,
        outputTokens: 150,
        reasoningTokens: 50,
        // (10*1 + 150*2) / 1e6 — reasoning not added again
        estimatedCostUsd: 0.00031,
        priceModelId: "google/gemini",
      }),
    });
  });

  test("ai-sdk Anthropic-shaped usage peels priced cache read and write once", async () => {
    const catalog: OpenRouterPriceCatalog = {
      find: () => ({ id: "anthropic/claude", input: 2, output: 10, cacheRead: 0.5, cacheWrite: 3 }),
    };
    const finish: TextStreamPart<ToolSet> = {
      type: "finish",
      finishReason: "stop",
      rawFinishReason: "stop",
      totalUsage: {
        inputTokenDetails: { cacheReadTokens: 40, cacheWriteTokens: 10, noCacheTokens: 50 },
        inputTokens: 100,
        outputTokenDetails: { reasoningTokens: undefined, textTokens: 20 },
        outputTokens: 20,
        totalTokens: 120,
      },
    };
    const captured = createUsageCapture({ priceCatalogTask: async () => catalog }).stream({
      providerId: "provider",
      modelId: "claude",
      stream: textStream([finish]),
    });
    await drain(captured.value);
    await expect(captured.completion).resolves.toEqual({
      outcome: "success",
      usage: expect.objectContaining({
        inputTokens: 100,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        // billable input 50: (50*2 + 20*10 + 40*0.5 + 10*3) / 1e6
        estimatedCostUsd: 0.00035,
        priceModelId: "anthropic/claude",
      }),
    });
  });

  test("passthrough OpenAI SSE keeps raw input and peels priced cache", async () => {
    const body = [
      'data: {"id":"chatcmpl-2","choices":[{"index":0,"delta":{"content":"Hi"}}]}',
      "",
      'data: {"id":"chatcmpl-2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2006,"completion_tokens":300,"total_tokens":2306,"prompt_tokens_details":{"cached_tokens":1920}}}',
      "",
      "data: [DONE]",
    ].join("\n");
    const catalog: OpenRouterPriceCatalog = {
      find: () => ({ id: "openai/gpt-test", input: 2, output: 10, cacheRead: 0.5 }),
    };
    const captured = createUsageCapture({ priceCatalogTask: async () => catalog }).passthrough({
      response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "gpt",
    });
    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({
      outcome: "success",
      statusCode: 200,
      usage: expect.objectContaining({
        inputTokens: 2006,
        cacheReadTokens: 1920,
        outputTokens: 300,
        estimatedCostUsd: 0.004132,
        priceModelId: "openai/gpt-test",
      }),
    });
  });

  test("passthrough OpenAI without cacheRead price does not undercharge", async () => {
    const body = JSON.stringify({
      usage: {
        prompt_tokens: 2006,
        completion_tokens: 300,
        total_tokens: 2306,
        prompt_tokens_details: { cached_tokens: 1920 },
      },
    });
    const catalog: OpenRouterPriceCatalog = {
      find: () => ({ id: "openai/gpt-test", input: 2, output: 10 }),
    };
    const captured = createUsageCapture({ priceCatalogTask: async () => catalog }).passthrough({
      response: new Response(body, { headers: { "content-type": "application/json" } }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "gpt",
    });
    await captured.value.text();
    await expect(captured.completion).resolves.toEqual({
      outcome: "success",
      statusCode: 200,
      usage: expect.objectContaining({
        inputTokens: 2006,
        cacheReadTokens: 1920,
        estimatedCostUsd: 0.007012,
      }),
    });
  });
});
