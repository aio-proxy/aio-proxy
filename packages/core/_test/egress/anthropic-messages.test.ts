import { describe, expect, test } from "bun:test";
import type { TextStreamPart, ToolSet } from "ai";
import { writeAnthropicMessagesResponse, writeAnthropicMessagesSSE } from "../../src/index";

const toolParts = [
  { type: "tool-input-start", id: "tool-1", toolName: "weather" },
  { type: "tool-input-delta", id: "tool-1", delta: '{"city":"Paris"}' },
  { type: "tool-input-end", id: "tool-1" },
  {
    type: "finish",
    finishReason: "tool-calls",
    rawFinishReason: "tool_use",
    totalUsage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
  },
] satisfies readonly TextStreamPart<ToolSet>[];

async function collectSSE(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();

  for await (const chunk of stream) {
    chunks.push(decoder.decode(chunk, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}

function partStream(parts: readonly TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
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

describe("writeAnthropicMessagesResponse", () => {
  test("Given tool input stream When encoded Then emits Anthropic tool_use content", async () => {
    await expect(writeAnthropicMessagesResponse(partStream(toolParts))).resolves.toEqual({
      id: "msg_aio_proxy",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "weather",
          input: { city: "Paris" },
        },
      ],
      model: "aio-proxy",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 4 },
    });
  });
});

describe("writeAnthropicMessagesSSE", () => {
  test("Given text stream When encoded Then emits Anthropic Messages SSE", async () => {
    const stream = partStream([
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

    await expect(collectSSE(writeAnthropicMessagesSSE(stream))).resolves.toBe(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_aio_proxy","type":"message","role":"assistant","content":[],"model":"aio-proxy","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n' +
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n' +
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":3,"output_tokens":2}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
  });

  test("Given unknown raw parts When encoded Then skips them without crashing", async () => {
    const stream = runtimePartStream([
      { type: "__future-part", payload: "ignored" },
      { type: "text-delta", id: "text-1", text: "safe" },
      { type: "raw", rawValue: { ignored: true } },
      { type: "error", error: new Error("ignored") },
      {
        type: "finish",
        finishReason: "stop",
        totalUsage: {},
      },
    ]);

    await expect(collectSSE(writeAnthropicMessagesSSE(stream))).resolves.toBe(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_aio_proxy","type":"message","role":"assistant","content":[],"model":"aio-proxy","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n' +
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"safe"}}\n\n' +
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
  });

  test("Given tool input stream When encoded Then emits Anthropic tool_use SSE", async () => {
    await expect(collectSSE(writeAnthropicMessagesSSE(partStream(toolParts)))).resolves.toBe(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_aio_proxy","type":"message","role":"assistant","content":[],"model":"aio-proxy","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n' +
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tool-1","name":"weather","input":{}}}\n\n' +
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Paris\\"}"}}\n\n' +
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":3,"output_tokens":4}}\n\n' +
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
  });
});
