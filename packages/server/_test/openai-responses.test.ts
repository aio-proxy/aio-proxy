import { describe, expect, test } from "bun:test";
import type {
  AiSdkProviderInstance,
  ApiProviderInstance,
} from "@aio-proxy/core";
import { createServer } from "@aio-proxy/server";
import type { CallSettings, ModelMessage, TextStreamPart, ToolSet } from "ai";

const responsesRequest = {
  model: "gpt-4.1-mini",
  input: "Say pong.",
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

function aiSdkProvider(
  invoke: AiSdkProviderInstance["invoke"],
): AiSdkProviderInstance {
  return {
    id: "mock-ai",
    kind: "ai-sdk",
    models: ["gpt-4.1-mini"],
    invoke,
  };
}

function unsupportedEnvelope(feature: string) {
  return {
    error: {
      code: "unsupported_feature",
      message: `OpenAI Responses feature is not supported: ${feature}`,
      type: "unsupported_feature",
    },
  };
}

const unsupportedBeforeProviderInvocationCases = [
  {
    body: { ...responsesRequest, previous_response_id: "resp-old" },
    feature: "previous_response_id",
    name: "previous_response_id",
  },
  {
    body: { ...responsesRequest, store: true },
    feature: "store",
    name: "store true",
  },
  {
    body: { ...responsesRequest, background: true },
    feature: "background",
    name: "background true",
  },
] as const;

describe("OpenAI Responses routes", () => {
  test("Given openai-responses native provider When POST is valid Then raw request and response bytes pass through", async () => {
    // Given
    const rawRequest =
      '{"model":"gpt-4.1-mini","input":"Say pong.","stream":false}';
    let bodySeen = "";
    const provider = {
      id: "openai",
      kind: "api",
      models: ["gpt-4.1-mini"],
      protocol: "openai-responses",
      vendor: "openai-native",
      async passthrough(req) {
        bodySeen = await req.text();
        return new Response('{"upstream":true}', {
          headers: { "content-type": "application/json", "x-upstream": "1" },
          status: 203,
        });
      },
    } satisfies ApiProviderInstance;
    const app = createServer({
      config: { providers: [] },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/responses", {
      body: rawRequest,
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(203);
    expect(response.headers.get("x-upstream")).toBe("1");
    expect(await response.text()).toBe('{"upstream":true}');
    expect(bodySeen).toBe(rawRequest);
  });

  test("Given ai-sdk provider When POST streams text Then Responses SSE events are returned", async () => {
    // Given
    let messagesSeen: readonly ModelMessage[] | undefined;
    let settingsSeen: CallSettings | undefined;
    let toolsSeen: ToolSet | undefined;
    const provider = aiSdkProvider((messages, settings, tools) => {
      messagesSeen = messages;
      settingsSeen = settings;
      toolsSeen = tools;
      return textStream([
        { type: "text-delta", id: "text-1", text: "pong" },
        {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: "stop",
          totalUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        },
      ]);
    });
    const app = createServer({
      config: { providers: [] },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        ...responsesRequest,
        tools: [{ type: "function", name: "lookup" }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const text = await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(messagesSeen).toEqual([{ role: "user", content: "Say pong." }]);
    expect(settingsSeen).toEqual({ stream: true });
    expect(Object.keys(toolsSeen ?? {})).toEqual(["lookup"]);
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.output_item.added");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain('"delta":"pong"');
    expect(text).toContain("event: response.completed");
  });

  test("Given ai-sdk provider When POST streams reasoning Then reasoning summary deltas are returned", async () => {
    // Given
    const provider = aiSdkProvider(() =>
      textStream([
        { type: "reasoning-delta", id: "reason-1", text: "Thinking" },
        {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: "stop",
          totalUsage: {},
        },
      ]),
    );
    const app = createServer({
      config: { providers: [] },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(responsesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const text = await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(text).toContain("event: response.reasoning_summary_text.delta");
    expect(text).toContain('"delta":"Thinking"');
  });

  test("Given ai-sdk provider When POST is non-stream Then Responses JSON is returned", async () => {
    // Given
    const provider = aiSdkProvider(() =>
      textStream([
        { type: "text-delta", id: "text-1", text: "Pong" },
        {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: "stop",
          totalUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        },
      ]),
    );
    const app = createServer({
      config: { providers: [] },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({ ...responsesRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body).toEqual({
      id: "resp-aio-proxy",
      object: "response",
      output: [
        {
          id: "msg-aio-proxy",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Pong" }],
        },
      ],
      status: "completed",
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    });
  });

  for (const scenario of unsupportedBeforeProviderInvocationCases) {
    test(`Given ${scenario.name} When POST is requested Then unsupported feature is returned before provider invocation`, async () => {
      // Given
      let invoked = false;
      const provider = aiSdkProvider(() => {
        invoked = true;
        return textStream([]);
      });
      const app = createServer({
        config: { providers: [] },
        providerInstances: [provider],
      });

      // When
      const response = await app.request("/v1/responses", {
        body: JSON.stringify(scenario.body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      // Then
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual(
        unsupportedEnvelope(scenario.feature),
      );
      expect(invoked).toBe(false);
    });
  }

  test("Given forbidden built-in tool When POST is requested Then unsupported feature is returned", async () => {
    // Given
    const app = createServer({ config: { providers: [] } });

    // When
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        ...responsesRequest,
        tools: [{ type: "web_search_preview" }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual(
      unsupportedEnvelope("web_search_preview"),
    );
  });

  test("Given stored response id When GET is requested Then retrieval is unsupported", async () => {
    // Given
    const app = createServer({ config: { providers: [] } });

    // When
    const response = await app.request("/v1/responses/resp-1");

    // Then
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual(
      unsupportedEnvelope("response_retrieval"),
    );
  });

  test("Given malformed JSON When POST is requested Then invalid request is returned before provider invocation", async () => {
    // Given
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = createServer({
      config: { providers: [] },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/responses", {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Invalid OpenAI Responses request",
        type: "invalid_request_error",
      },
    });
    expect(invoked).toBe(false);
  });
});
