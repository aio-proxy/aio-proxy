import { describe, expect, test } from "bun:test";
import { type AiSdkProviderInstance, type ApiProviderInstance, createAiSdkProvider } from "@aio-proxy/core";
import { createServer } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";
import type { ModelMessage, TextStreamPart, ToolSet } from "ai";

const chatRequest = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello proxy" }],
  stream: true,
};

function textStream(parts: readonly TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

function errorStream(error: Error): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      controller.error(error);
    },
  });
}

class UpstreamStatusError extends Error {
  readonly statusCode = 401;
}

class AbortStreamError extends Error {
  override readonly name = "AbortError";
}

describe("POST /v1/chat/completions", () => {
  test("Given openai-compatible api provider When completion is posted Then passthrough receives original request", async () => {
    // Given
    let bodySeen: unknown;
    const provider = {
      id: "openai",
      kind: "api",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      async passthrough(req) {
        bodySeen = await req.json();
        return new Response("provider-bytes", {
          headers: { "x-provider": "openai" },
          status: 202,
        });
      },
    } satisfies ApiProviderInstance;
    const app = createServer({
      config: { providers: {} },
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

  test("Given openai-compatible api provider When non-stream completion is posted Then passthrough receives original request", async () => {
    // Given
    let bodySeen: unknown;
    const provider = {
      id: "openai",
      kind: "api",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      async passthrough(req) {
        bodySeen = await req.json();
        return Response.json(
          {
            id: "chatcmpl-upstream",
            object: "chat.completion",
            choices: [],
          },
          { status: 200 },
        );
      },
    } satisfies ApiProviderInstance;
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });
    const request = { ...chatRequest, stream: false };

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body).toEqual({
      id: "chatcmpl-upstream",
      object: "chat.completion",
      choices: [],
    });
    expect(bodySeen).toEqual(request);
  });

  test("Given ai-sdk provider When stream completion is posted Then provider is invoked and OpenAI SSE is returned", async () => {
    // Given
    let messagesSeen: readonly ModelMessage[] | undefined;
    let modelSeen: string | undefined;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
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
      config: { providers: {} },
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
    expect(modelSeen).toBe("gpt-4o-mini");
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain('"content":"pong"');
    expect(text).toContain("data: [DONE]");
  });

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
    const app = createServer({
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
    expect(body).toEqual({
      ...body,
      object: "chat.completion",
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          message: { role: "assistant", content: "Hello" },
        },
      ],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
      },
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
    const app = createServer({
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

  test("Given first provider returns 429 When completion is posted Then next provider is used", async () => {
    const first = {
      id: "rate-limited",
      kind: "api",
      models: ["gpt-5-mini"],
      alias: { "gpt-5-mini": { model: "gpt-5-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      passthrough: async () => Response.json({ error: "rate limited" }, { status: 429 }),
    } satisfies ApiProviderInstance;
    const second = {
      id: "ok",
      kind: "ai-sdk",
      models: ["gpt-5-mini"],
      alias: { "gpt-5-mini": { model: "gpt-5-mini", preserve: false } },
      invoke: () =>
        textStream([
          { type: "text-start", id: "fallback" },
          { type: "text-delta", id: "fallback", text: "fallback ok" },
          { type: "text-end", id: "fallback" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]),
    } satisfies AiSdkProviderInstance;
    const app = createServer({ config: { providers: {} }, providerInstances: [first, second] });

    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }] }),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).toContain("fallback ok");
  });

  test("Given first provider returns 400 When completion is posted Then no fallback occurs", async () => {
    let secondCalled = false;
    const first = {
      id: "bad-request",
      kind: "api",
      models: ["gpt-5-mini"],
      alias: { "gpt-5-mini": { model: "gpt-5-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      passthrough: async () => Response.json({ error: "bad request" }, { status: 400 }),
    } satisfies ApiProviderInstance;
    const second = {
      id: "ok",
      kind: "ai-sdk",
      models: ["gpt-5-mini"],
      alias: { "gpt-5-mini": { model: "gpt-5-mini", preserve: false } },
      invoke: () => {
        secondCalled = true;
        return textStream([
          { type: "text-start", id: "fallback" },
          { type: "text-delta", id: "fallback", text: "fallback ok" },
          { type: "text-end", id: "fallback" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({ config: { providers: {} }, providerInstances: [first, second] });

    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(response.status).toBe(400);
    expect(secondCalled).toBe(false);
  });

  test("Given ai-sdk provider returns upstream status error When non-stream completion is posted Then OpenAI error hides provider id", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        return errorStream(new UpstreamStatusError("upstream denied"));
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const text = await response.text();
    const body = JSON.parse(text);

    // Then
    expect(response.status).toBe(401);
    expect(body).toEqual({
      error: {
        code: "upstream_error",
        message: "upstream denied",
        type: "invalid_request_error",
      },
    });
    expect(text).not.toContain("mock-ai");
  });

  test("Given ai-sdk provider returns abort error When non-stream completion is posted Then OpenAI error uses 499", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        return errorStream(new AbortStreamError("client closed request"));
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({
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
    expect(response.status).toBe(499);
    expect(body).toEqual({
      error: {
        code: "aborted",
        message: "client closed request",
        type: "invalid_request_error",
      },
    });
  });

  test("Given ai-sdk provider package is missing When non-stream completion is posted Then OpenAI error is actionable 503", async () => {
    // Given
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "missing-ai",
        packageName: "@vendor/missing-provider",
        models: ["gpt-4o-mini"],
        alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      },
      {
        async loadProvider() {
          return null;
        },
      },
    );
    const app = createServer({
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
    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: {
        code: "provider_not_installed",
        message:
          'missing-ai: ai-sdk provider package "@vendor/missing-provider" is not installed; run aio-proxy provider install @vendor/missing-provider',
        type: "invalid_request_error",
      },
    });
  });

  test("Given ai-sdk provider package is missing When stream completion is posted Then OpenAI error is actionable 503", async () => {
    // Given
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "missing-ai",
        packageName: "@vendor/missing-provider",
        models: ["gpt-4o-mini"],
        alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      },
      {
        async loadProvider() {
          return null;
        },
      },
    );
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify(chatRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).not.toContain("text/event-stream");
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: "provider_not_installed",
        message:
          'missing-ai: ai-sdk provider package "@vendor/missing-provider" is not installed; run aio-proxy provider install @vendor/missing-provider',
        type: "invalid_request_error",
      },
    });
  });

  test("Given ai-sdk provider returns generic error When non-stream completion is posted Then OpenAI error hides provider id", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        throw new Error("model exploded");
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const text = await response.text();
    const body = JSON.parse(text);

    // Then
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "internal_error",
        message: "model exploded",
        type: "invalid_request_error",
      },
    });
    expect(text).not.toContain("mock-ai");
  });

  test("Given no matching alias When completion is posted Then returns 404 OpenAI error envelope", async () => {
    // Given
    let invoked = false;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        invoked = true;
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({
      config: { providers: {} },
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

  test("Given oversized content-length When completion is posted Then rejects before provider invocation", async () => {
    // Given
    let invoked = false;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        invoked = true;
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({
      config: { providers: {} },
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
