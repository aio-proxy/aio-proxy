import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import type { TextStreamPart, ToolSet } from "ai";

import { describe, expect, test } from "bun:test";

import {
  writeOpenAICompletionsResponse as writeOpenAICompletionsResponseRaw,
  writeOpenAICompletionsSSE as writeOpenAICompletionsSSERaw,
} from "../../src/index";

const defaultEgress = { modelId: "test-model" };
const writeOpenAICompletionsResponse = (
  stream: Parameters<typeof writeOpenAICompletionsResponseRaw>[0],
  context = defaultEgress,
) => writeOpenAICompletionsResponseRaw(stream, context);
const writeOpenAICompletionsSSE = (
  stream: Parameters<typeof writeOpenAICompletionsSSERaw>[0],
  context = defaultEgress,
) => writeOpenAICompletionsSSERaw(stream, context);

const doneFrame = "data: [DONE]\n\n";

async function collectSSE(stream: ReadableStream<Uint8Array>, compactOfficialFields = true): Promise<string> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();

  for await (const chunk of stream) {
    chunks.push(decoder.decode(chunk, { stream: true }));
  }

  chunks.push(decoder.decode());
  const value = chunks.join("").replaceAll(/chatcmpl-[^"]+/g, "chatcmpl-test");
  return compactOfficialFields
    ? value
        .replaceAll(/,"created":\d+,"model":"test-model"/g, "")
        .replaceAll(',"finish_reason":null', "")
        .replaceAll('{"prompt_tokens":0,"completion_tokens":0,"total_tokens":9}', '{"total_tokens":9}')
    : value;
}

function partStream(parts: readonly LanguageModelV2StreamPart[]): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

function aiSdkPartStream(parts: readonly TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

function runtimePartStream(parts: readonly object[]) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

describe("writeOpenAICompletionsSSE", () => {
  test("Given downstream cancellation When source is open Then source is cancelled", async () => {
    let cancelCalls = 0;
    const source = new ReadableStream<TextStreamPart<ToolSet>>({
      start(controller) {
        controller.enqueue({ type: "text-delta", id: "text-1", text: "partial" });
      },
      cancel() {
        cancelCalls += 1;
      },
    });

    const reader = new Response(writeOpenAICompletionsSSE(source)).body?.getReader();
    await reader?.read();
    await reader?.cancel("client stopped");

    expect(cancelCalls).toBe(1);
  });

  test("Given finish-step metadata When encoded as response Then upstream metadata is reused", async () => {
    const response = await writeOpenAICompletionsResponse(
      runtimePartStream([
        { type: "text-delta", id: "text-1", text: "pong" },
        {
          type: "finish-step",
          response: {
            id: "chatcmpl-upstream",
            modelId: "gpt-upstream",
            timestamp: new Date("2026-07-12T00:00:05.000Z"),
          },
        },
        { type: "finish", finishReason: "stop", totalUsage: {} },
      ]) as never,
      { modelId: "gpt-fallback" },
    );

    expect(response).toMatchObject({ id: "chatcmpl-upstream", model: "gpt-upstream", created: 1_783_814_405 });
  });

  test("Given tool-call stream When encoded as response Then assistant tool calls are preserved", async () => {
    const response = await writeOpenAICompletionsResponse(
      partStream([
        { type: "tool-input-start", id: "call_1", toolName: "lookup" },
        { type: "tool-input-delta", id: "call_1", delta: '{"q":"pizza"}' },
        { type: "tool-input-end", id: "call_1" },
        {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        },
      ]),
    );

    expect(response.choices[0]).toMatchObject({
      finish_reason: "tool_calls",
      message: {
        content: null,
        role: "assistant",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "lookup", arguments: '{"q":"pizza"}' },
          },
        ],
      },
    });
  });

  test("Given stream egress context When encoded Then chunks include resolved model and creation time", async () => {
    const value = await collectSSE(
      writeOpenAICompletionsSSE(
        aiSdkPartStream([
          { type: "text-delta", id: "text-1", text: "pong" },
          { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: {} },
        ]),
        { modelId: "gpt-routed" },
      ),
      false,
    );
    const first = JSON.parse(value.split("\n")[0]?.slice("data: ".length) ?? "null") as Record<string, unknown>;

    expect(first.model).toBe("gpt-routed");
    expect(first.created).toBeNumber();
  });

  test("Given text stream When encoded as response Then id does not expose aio-proxy", async () => {
    const response = await writeOpenAICompletionsResponse(
      aiSdkPartStream([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", text: "pong" },
        { type: "text-end", id: "text-1" },
      ]),
    );

    expect(response.id).toStartWith("chatcmpl-");
    expect(response.id).not.toContain("aio-proxy");
  });

  test("Given AI SDK text stream When encoded Then uses text and total usage", async () => {
    const stream = aiSdkPartStream([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "pong" },
      { type: "text-end", id: "text-1" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
    ]);

    await expect(collectSSE(writeOpenAICompletionsSSE(stream))).resolves.toBe(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"content":"pong"},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":4,"total_tokens":7}}\n\n' +
        doneFrame,
    );
  });

  test("Given text-only stream When encoded Then emits exact Chat SSE", async () => {
    const stream = partStream([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "Hel" },
      { type: "text-delta", id: "text-1", delta: "lo" },
      { type: "text-end", id: "text-1" },
      {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      },
    ]);

    await expect(collectSSE(writeOpenAICompletionsSSE(stream))).resolves.toBe(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hel"},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"content":"lo"},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\n' +
        doneFrame,
    );
  });

  test("Given tool-call stream When encoded Then emits accumulated arguments", async () => {
    const stream = partStream([
      { type: "tool-input-start", id: "call_1", toolName: "lookup" },
      { type: "tool-input-delta", id: "call_1", delta: '{"q":"' },
      { type: "tool-input-delta", id: "call_1", delta: 'pizza"}' },
      { type: "tool-input-end", id: "call_1" },
      {
        type: "finish",
        finishReason: "tool-calls",
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: 9,
        },
      },
    ]);

    await expect(collectSSE(writeOpenAICompletionsSSE(stream))).resolves.toBe(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":""}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":\\""}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":\\"pizza\\"}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":\\"pizza\\"}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}],"usage":{"total_tokens":9}}\n\n' +
        doneFrame,
    );
  });

  test("Given mixed text and tool stream When encoded Then preserves chunk order", async () => {
    const stream = partStream([
      { type: "text-delta", id: "text-1", delta: "Checking " },
      { type: "tool-input-start", id: "call_1", toolName: "lookup" },
      { type: "tool-input-delta", id: "call_1", delta: "{}" },
      { type: "tool-input-end", id: "call_1" },
      { type: "text-delta", id: "text-1", delta: "done" },
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        },
      },
    ]);

    await expect(collectSSE(writeOpenAICompletionsSSE(stream))).resolves.toBe(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"content":"Checking "},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":""}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"lookup","arguments":"{}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"content":"done"},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n\n' +
        doneFrame,
    );
  });

  test("Given multiple tools When encoded Then indexes follow stream order", async () => {
    const stream = partStream([
      { type: "tool-input-start", id: "call_b", toolName: "second" },
      { type: "tool-input-start", id: "call_a", toolName: "first" },
      { type: "tool-input-delta", id: "call_a", delta: '{"a":1}' },
      { type: "tool-input-delta", id: "call_b", delta: '{"b":2}' },
      { type: "tool-input-end", id: "call_a" },
      { type: "tool-input-end", id: "call_b" },
      {
        type: "finish",
        finishReason: "tool-calls",
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        },
      },
    ]);

    await expect(collectSSE(writeOpenAICompletionsSSE(stream))).resolves.toBe(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_b","type":"function","function":{"name":"second","arguments":""}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_a","type":"function","function":{"name":"first","arguments":""}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_a","type":"function","function":{"name":"first","arguments":"{\\"a\\":1}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_b","type":"function","function":{"name":"second","arguments":"{\\"b\\":2}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_a","type":"function","function":{"name":"first","arguments":"{\\"a\\":1}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_b","type":"function","function":{"name":"second","arguments":"{\\"b\\":2}"}}]},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"tool_calls"}]}\n\n' +
        doneFrame,
    );
  });

  test("Given unknown raw and error parts When encoded Then skips them and emits DONE", async () => {
    const stream = runtimePartStream([
      { type: "text-delta", id: "text-1", delta: "safe" },
      { type: "raw", rawValue: { ignored: true } },
      { type: "__future-part", payload: "ignored" },
      { type: "error", error: new Error("ignored") },
      {
        type: "finish",
        finishReason: "stop",
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        },
      },
    ]);

    await expect(collectSSE(writeOpenAICompletionsSSE(stream))).resolves.toBe(
      'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{"content":"safe"},"index":0}]}\n\n' +
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}\n\n' +
        doneFrame,
    );
  });
});
