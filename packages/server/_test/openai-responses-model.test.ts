import { describe, expect, test } from "bun:test";
import type { AiSdkProviderInstance } from "@aio-proxy/core";
import { createServer } from "@aio-proxy/server";
import type { CallSettings, ModelMessage, ToolSet } from "ai";

import { aiSdkProvider, responsesRequest, textStream } from "./openai-responses.test-support";

describe("OpenAI Responses routes", () => {
  test("Given ai-sdk provider When POST streams text Then Responses SSE events are returned", async () => {
    // Given
    let messagesSeen: readonly ModelMessage[] | undefined;
    let modelSeen: string | undefined;
    let settingsSeen: CallSettings | undefined;
    let toolsSeen: ToolSet | undefined;
    const provider = aiSdkProvider((request) => {
      messagesSeen = request.messages;
      modelSeen = request.modelId;
      settingsSeen = request.settings;
      toolsSeen = request.tools;
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
    const app = await createServer({
      config: { providers: {} },
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
    expect(modelSeen).toBe("gpt-4.1-mini");
    expect(settingsSeen).toEqual({ stream: true });
    expect(Object.keys(toolsSeen ?? {})).toEqual(["lookup"]);
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.output_item.added");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain('"delta":"pong"');
    expect(text).toContain("event: response.completed");
  });

  test("Given an alias variant and ai-sdk provider When POST is valid Then reasoning selects and configures it", async () => {
    // Given
    let modelSeen: string | undefined;
    let settingsSeen: CallSettings | undefined;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-default", "gpt-high"],
      alias: {
        mini: {
          model: "gpt-default",
          preserve: false,
          variants: { high: { model: "gpt-high", preserve: false } },
        },
      },
      invoke(request) {
        modelSeen = request.modelId;
        settingsSeen = request.settings;
        return textStream([
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
          },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });

    // When
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({ ...responsesRequest, model: "mini", reasoning: { effort: "high" } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(modelSeen).toBe("gpt-high");
    expect(settingsSeen).toEqual({ reasoning: "high", stream: true });
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
    const app = await createServer({
      config: { providers: {} },
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

  test("Given ai-sdk provider When POST streams a tool call Then official function-call events are returned", async () => {
    const provider = aiSdkProvider(() =>
      textStream([
        { type: "tool-input-start", id: "call_1", toolName: "get_weather" },
        { type: "tool-input-delta", id: "call_1", delta: '{"city":"Paris"}' },
        { type: "tool-input-end", id: "call_1" },
      ]),
    );
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });

    const response = await app.request("/v1/responses", {
      body: JSON.stringify(responsesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const eventTypes = (await response.text())
      .trim()
      .split("\n\n")
      .map((frame) => JSON.parse(frame.split("\n")[1]?.slice("data: ".length) ?? "null").type);

    expect(eventTypes).toEqual([
      "response.created",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.completed",
    ]);
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
    const app = await createServer({
      config: { providers: {} },
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
    expect(body.id).toStartWith("resp_");
    expect(body).toMatchObject({
      object: "response",
      model: "gpt-4.1-mini",
      output_text: "Pong",
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "Pong", annotations: [] }],
        },
      ],
      status: "completed",
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    });
  });

  test("Given ai-sdk provider When POST is non-stream with a tool call Then function_call output is returned", async () => {
    const provider = aiSdkProvider(() =>
      textStream([
        { type: "tool-input-start", id: "call_1", toolName: "get_weather" },
        { type: "tool-input-delta", id: "call_1", delta: '{"city":"Paris"}' },
        { type: "tool-input-end", id: "call_1" },
      ]),
    );
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });

    const response = await app.request("/v1/responses", {
      body: JSON.stringify({ ...responsesRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(await response.json()).toMatchObject({
      output: [
        {
          type: "function_call",
          id: expect.stringMatching(/^fc_/),
          call_id: "call_1",
          name: "get_weather",
          arguments: '{"city":"Paris"}',
          status: "completed",
        },
      ],
    });
  });
});
