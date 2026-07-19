import type { AiSdkProviderInstance } from "@aio-proxy/core";
import type { ModelMessage, ToolSet } from "ai";

import { createServer } from "@aio-proxy/server";
import { describe, expect, test } from "bun:test";

import { messagesRequest, textStream } from "./anthropic-messages.test-support";

describe("POST /v1/messages", () => {
  test("Given tool-use and tool-result history When message is posted Then model receives complete tool parts", async () => {
    let messagesSeen: readonly ModelMessage[] | undefined;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      invoke(request) {
        messagesSeen = request.messages;
        return textStream([
          { type: "text-start", id: "text-1" },
          { type: "text-end", id: "text-1" },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });

    await app.request("/v1/messages", {
      body: JSON.stringify({
        ...messagesRequest,
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_weather", name: "weather", input: { city: "Paris" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_weather", content: "Sunny" }],
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(messagesSeen).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "toolu_weather", toolName: "weather", input: { city: "Paris" } }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_weather",
            toolName: "weather",
            output: { type: "text", value: "Sunny" },
          },
        ],
      },
    ]);
  });

  test("Given Anthropic tool definitions When routed through AI SDK Then model receives tools", async () => {
    let toolsSeen: ToolSet | undefined;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      invoke(request) {
        toolsSeen = request.tools;
        return textStream([{ type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: {} }]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });

    const response = await app.request("/v1/messages", {
      body: JSON.stringify({
        ...messagesRequest,
        stream: false,
        tools: [
          {
            name: "get_weather",
            description: "Returns weather for a city.",
            input_schema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(Object.keys(toolsSeen ?? {})).toEqual(["get_weather"]);
    expect(toolsSeen?.get_weather?.description).toBe("Returns weather for a city.");
  });

  test("Given ai-sdk provider When stream message is posted Then provider is invoked and Anthropic SSE is returned", async () => {
    // Given
    let messagesSeen: readonly ModelMessage[] | undefined;
    let modelSeen: string | undefined;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
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
    const app = await createServer({
      config: { providers: {} },
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
});
