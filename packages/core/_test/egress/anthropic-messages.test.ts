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

async function collectSSEFrames(stream: ReadableStream<Uint8Array>) {
  return (await collectSSE(stream))
    .trim()
    .split("\n\n")
    .map((frame) => {
      const [eventLine, dataLine] = frame.split("\n");
      return {
        event: eventLine?.slice("event: ".length),
        data: JSON.parse(dataLine?.slice("data: ".length) ?? "null") as unknown,
      };
    });
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

  test("Given interleaved text and tools When encoded Then preserves content-block order", async () => {
    const stream = partStream([
      { type: "tool-input-start", id: "tool-1", toolName: "weather" },
      { type: "tool-input-delta", id: "tool-1", delta: '{"city":' },
      { type: "tool-input-delta", id: "tool-1", delta: '"Paris"' },
      { type: "tool-input-end", id: "tool-1" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "After " },
      { type: "text-delta", id: "text-1", text: "weather." },
      { type: "text-end", id: "text-1" },
      { type: "tool-input-start", id: "tool-2", toolName: "clock" },
      { type: "tool-input-delta", id: "tool-2", delta: '{"zone":' },
      { type: "tool-input-delta", id: "tool-2", delta: '"UTC"}' },
      { type: "tool-input-end", id: "tool-2" },
      { type: "text-start", id: "text-2" },
      { type: "text-delta", id: "text-2", text: " Done." },
      { type: "text-end", id: "text-2" },
      {
        type: "finish",
        finishReason: "tool-calls",
        rawFinishReason: "tool_use",
        totalUsage: { inputTokens: 5, outputTokens: 8, totalTokens: 13 },
      },
    ]);

    await expect(writeAnthropicMessagesResponse(stream)).resolves.toEqual({
      id: "msg_aio_proxy",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool-1",
          name: "weather",
          input: '{"city":"Paris"',
        },
        { type: "text", text: "After weather." },
        {
          type: "tool_use",
          id: "tool-2",
          name: "clock",
          input: { zone: "UTC" },
        },
        { type: "text", text: " Done." },
      ],
      model: "aio-proxy",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 8 },
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

  test("Given interleaved open blocks When finished Then indices stay associated and all blocks close", async () => {
    const frames = await collectSSEFrames(
      writeAnthropicMessagesSSE(
        partStream([
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", text: "before" },
          { type: "tool-input-start", id: "tool-1", toolName: "weather" },
          { type: "tool-input-start", id: "tool-2", toolName: "clock" },
          { type: "tool-input-delta", id: "tool-1", delta: '{"city":"Paris"}' },
          { type: "tool-input-delta", id: "tool-2", delta: '{"zone":"UTC"}' },
          { type: "text-start", id: "text-2" },
          { type: "text-delta", id: "text-2", text: "after" },
          {
            type: "finish",
            finishReason: "tool-calls",
            rawFinishReason: "tool_use",
            totalUsage: { inputTokens: 5, outputTokens: 8, totalTokens: 13 },
          },
        ]),
      ),
    );

    expect(frames.filter((frame) => frame.event === "content_block_start").map((frame) => frame.data)).toEqual([
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tool-1", name: "weather", input: {} },
      },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "tool-2", name: "clock", input: {} },
      },
      { type: "content_block_start", index: 3, content_block: { type: "text", text: "" } },
    ]);
    expect(
      frames
        .filter(
          (frame) =>
            frame.event === "content_block_delta" &&
            typeof frame.data === "object" &&
            frame.data !== null &&
            "delta" in frame.data &&
            (frame.data.delta as { type?: string }).type === "input_json_delta",
        )
        .map((frame) => frame.data),
    ).toEqual([
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"city":"Paris"}' },
      },
      {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"zone":"UTC"}' },
      },
    ]);

    const messageDeltaIndex = frames.findIndex((frame) => frame.event === "message_delta");
    expect(messageDeltaIndex).toBeGreaterThan(0);
    expect(
      frames
        .slice(0, messageDeltaIndex)
        .filter((frame) => frame.event === "content_block_stop")
        .map((frame) => (frame.data as { index: number }).index),
    ).toEqual([0, 1, 2, 3]);
    expect(frames.slice(messageDeltaIndex + 1).some((frame) => frame.event === "content_block_stop")).toBeFalse();
  });

  test("Given a stale text-end id When encoded Then it does not close the active text block", async () => {
    const frames = await collectSSEFrames(
      writeAnthropicMessagesSSE(
        partStream([
          { type: "text-start", id: "text-old" },
          { type: "text-delta", id: "text-old", text: "old" },
          { type: "text-end", id: "text-old" },
          { type: "text-start", id: "text-current" },
          { type: "text-delta", id: "text-current", text: "current" },
          { type: "text-end", id: "text-old" },
          { type: "text-delta", id: "text-current", text: "!" },
          { type: "text-end", id: "text-current" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          },
        ]),
      ),
    );

    expect(
      frames
        .filter(
          (frame) =>
            frame.event === "content_block_delta" &&
            typeof frame.data === "object" &&
            frame.data !== null &&
            "delta" in frame.data &&
            (frame.data.delta as { type?: string }).type === "text_delta",
        )
        .map((frame) => frame.data),
    ).toEqual([
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "old" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "current" } },
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "!" } },
    ]);
  });
});
