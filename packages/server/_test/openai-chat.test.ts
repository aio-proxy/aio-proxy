import { describe, expect, test } from "bun:test";
import type {
  AiSdkProviderInstance,
  ApiProviderInstance,
} from "@aio-proxy/core";
import { createServer } from "@aio-proxy/server";
import type { ModelMessage, TextStreamPart, ToolSet } from "ai";

const chatRequest = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello proxy" }],
  stream: true,
};

function textStream(
  parts: readonly TextStreamPart<ToolSet>[],
): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

describe("POST /v1/chat/completions", () => {
  test("Given openai-native api provider When chat completion is posted Then passthrough receives original request", async () => {
    // Given
    let bodySeen: unknown;
    const provider = {
      id: "openai",
      kind: "api",
      models: ["gpt-4o-mini"],
      protocol: "openai-chat",
      vendor: "openai-native",
      async passthrough(req) {
        bodySeen = await req.json();
        return new Response("provider-bytes", {
          headers: { "x-provider": "openai" },
          status: 202,
        });
      },
    } satisfies ApiProviderInstance;
    const app = createServer({
      config: { providers: [] },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify(chatRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(202);
    expect(response.headers.get("x-provider")).toBe("openai");
    expect(await response.text()).toBe("provider-bytes");
    expect(bodySeen).toEqual(chatRequest);
  });

  test("Given ai-sdk provider When stream chat completion is posted Then provider is invoked and OpenAI SSE is returned", async () => {
    // Given
    let messagesSeen: readonly ModelMessage[] | undefined;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      invoke(messages) {
        messagesSeen = messages;
        return textStream([
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", text: "pong" },
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
    const app = createServer({
      config: { providers: [] },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify(chatRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const text = await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(messagesSeen).toEqual([{ role: "user", content: "Hello proxy" }]);
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain('"content":"pong"');
    expect(text).toContain("data: [DONE]");
  });

  test("Given no matching alias When chat completion is posted Then returns 404 OpenAI error envelope", async () => {
    // Given
    let invoked = false;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      invoke() {
        invoked = true;
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({
      config: { providers: [] },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, model: "missing-model" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: {
        code: "model_not_found",
        message: "Model not found: missing-model",
        type: "invalid_request_error",
      },
    });
    expect(invoked).toBe(false);
  });

  test("Given oversized content-length When chat completion is posted Then rejects before provider invocation", async () => {
    // Given
    let invoked = false;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      invoke() {
        invoked = true;
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({
      config: { providers: [] },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: "{}",
      headers: {
        "content-length": String(8 * 1_024 * 1_024 + 1),
        "content-type": "application/json",
      },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(413);
    expect(body).toEqual({
      error: {
        code: "request_too_large",
        message: "Request body too large",
        type: "invalid_request_error",
      },
    });
    expect(invoked).toBe(false);
  });
});
