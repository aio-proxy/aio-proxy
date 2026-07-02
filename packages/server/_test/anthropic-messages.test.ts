import { describe, expect, test } from "bun:test";
import type {
  AiSdkProviderInstance,
  ApiProviderInstance,
} from "@aio-proxy/core";
import { createAiSdkProvider } from "@aio-proxy/core";
import { createServer } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";
import type { ModelMessage, TextStreamPart, ToolSet } from "ai";

const messagesRequest = {
  model: "claude-sonnet-4-5",
  max_tokens: 32,
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

describe("POST /v1/messages", () => {
  test("Given anthropic api provider When message is posted Then passthrough receives original request", async () => {
    // Given
    let bodySeen: unknown;
    const provider = {
      id: "anthropic",
      kind: "api",
      models: ["claude-sonnet-4-5"],
      protocol: ProviderProtocol.Anthropic,
      async passthrough(req) {
        bodySeen = await req.json();
        return new Response("provider-bytes", {
          headers: { "x-provider": "anthropic" },
          status: 202,
        });
      },
    } satisfies ApiProviderInstance;
    const app = createServer({
      config: { providers: [] },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/messages", {
      body: JSON.stringify(messagesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(202);
    expect(response.headers.get("x-provider")).toBe("anthropic");
    expect(await response.text()).toBe("provider-bytes");
    expect(bodySeen).toEqual(messagesRequest);
  });

  test("Given ai-sdk provider When stream message is posted Then provider is invoked and Anthropic SSE is returned", async () => {
    // Given
    let messagesSeen: readonly ModelMessage[] | undefined;
    let modelSeen: string | undefined;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      invoke(request) {
        messagesSeen = request.messages;
        modelSeen = request.modelId;
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
    const response = await app.request("/v1/messages", {
      body: JSON.stringify(messagesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const text = await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(messagesSeen).toEqual([{ role: "user", content: "Hello proxy" }]);
    expect(modelSeen).toBe("claude-sonnet-4-5");
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain('"text":"pong"');
    expect(text).toContain("event: message_stop");
  });

  test("Given no matching alias When message is posted Then returns 404 Anthropic error envelope", async () => {
    // Given
    let invoked = false;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
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
    const response = await app.request("/v1/messages", {
      body: JSON.stringify({ ...messagesRequest, model: "missing-model" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(404);
    expect(body).toEqual({
      type: "error",
      error: {
        type: "not_found_error",
        message: "Model not found: missing-model",
      },
    });
    expect(invoked).toBe(false);
  });

  test("Given ai-sdk provider package is missing When stream message is posted Then Anthropic error is actionable 503 before SSE", async () => {
    // Given
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "missing-ai",
        packageName: "@vendor/missing-provider",
        models: ["claude-sonnet-4-5"],
      },
      {
        async loadProvider() {
          return null;
        },
      },
    );
    const app = createServer({
      config: { providers: [] },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/messages", {
      body: JSON.stringify(messagesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).not.toContain(
      "text/event-stream",
    );
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain(
      "run aio-proxy provider install @vendor/missing-provider",
    );
  });
});

describe("POST /v1/messages/count_tokens", () => {
  test("Given message request When token count is posted Then returns input token count", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      invoke() {
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({
      config: { providers: [] },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/messages/count_tokens", {
      body: JSON.stringify(messagesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body).toEqual({ input_tokens: 2 });
    expect(typeof body.input_tokens).toBe("number");
  });
});
