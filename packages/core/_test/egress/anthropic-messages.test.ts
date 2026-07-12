import { describe, expect, test } from "bun:test";
import type { TextStreamPart, ToolSet } from "ai";
import {
  writeAnthropicMessagesResponse as writeAnthropicMessagesResponseRaw,
  writeAnthropicMessagesSSE as writeAnthropicMessagesSSERaw,
} from "../../src/index";

const defaultEgress = { modelId: "test-model" };
const writeAnthropicMessagesResponse = (
  stream: Parameters<typeof writeAnthropicMessagesResponseRaw>[0],
  context = defaultEgress,
) => writeAnthropicMessagesResponseRaw(stream, context);
const writeAnthropicMessagesSSE = (
  stream: Parameters<typeof writeAnthropicMessagesSSERaw>[0],
  context = defaultEgress,
) => writeAnthropicMessagesSSERaw(stream, context);

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

async function collectSSE(stream: ReadableStream<Uint8Array>, normalizeId = true): Promise<string> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();

  for await (const chunk of stream) {
    chunks.push(decoder.decode(chunk, { stream: true }));
  }

  chunks.push(decoder.decode());
  const value = chunks.join("");
  return normalizeId ? value.replaceAll(/msg_[0-9a-f-]{36}/g, "msg-test") : value;
}

async function collectSSEFrames(stream: ReadableStream<Uint8Array>, normalizeId = true) {
  return (await collectSSE(stream, normalizeId))
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
  test("Given finish-step metadata When encoded Then upstream id and model are reused", async () => {
    const response = await writeAnthropicMessagesResponse(
      runtimePartStream([
        { type: "text-delta", id: "text-1", text: "Hello" },
        {
          type: "finish-step",
          response: {
            id: "msg_upstream",
            modelId: "claude-upstream",
            timestamp: new Date("2026-07-12T00:00:00.000Z"),
          },
        },
        { type: "finish", finishReason: "stop", totalUsage: { inputTokens: 1, outputTokens: 1 } },
      ]) as never,
      { modelId: "claude-fallback" },
    );

    expect(response.id).toBe("msg_upstream");
    expect(response.model).toBe("claude-upstream");
  });

  test("Given tool input stream When encoded Then emits Anthropic tool_use content", async () => {
    await expect(writeAnthropicMessagesResponse(partStream(toolParts))).resolves.toMatchObject({
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
      model: "test-model",
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

    await expect(writeAnthropicMessagesResponse(stream)).resolves.toMatchObject({
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
      model: "test-model",
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 8 },
    });
  });
});

describe("writeAnthropicMessagesSSE", () => {
  test("Given independent streams When encoded Then each uses one unique response-local id and resolved model", async () => {
    const encode = () =>
      collectSSEFrames(
        writeAnthropicMessagesSSE(
          partStream([
            { type: "text-delta", id: "text-1", text: "Hello" },
            { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: {} },
          ]),
          { modelId: "claude-routed" },
        ),
        false,
      );

    const [first, second] = await Promise.all([encode(), encode()]);
    const firstMessage = (first[0]?.data as { message: { id: string; model: string } }).message;
    const secondMessage = (second[0]?.data as { message: { id: string; model: string } }).message;

    expect(firstMessage.id).toStartWith("msg_");
    expect(firstMessage.id).not.toBe(secondMessage.id);
    expect(firstMessage.model).toBe("claude-routed");
  });

  test("Given an empty text block When encoded Then start and stop are preserved", async () => {
    const frames = await collectSSEFrames(
      writeAnthropicMessagesSSE(
        partStream([
          { type: "text-start", id: "text-empty" },
          { type: "text-end", id: "text-empty" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
          },
        ]),
      ),
    );

    expect(frames.filter((frame) => frame.event.startsWith("content_block_"))).toEqual([
      {
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "", citations: null },
        },
      },
      { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
    ]);
  });

  test("Given empty text and tool blocks When encoded Then first-appearance order determines indices", async () => {
    const frames = await collectSSEFrames(
      writeAnthropicMessagesSSE(
        partStream([
          { type: "text-start", id: "text-empty" },
          { type: "tool-input-start", id: "tool-1", toolName: "weather" },
          { type: "text-end", id: "text-empty" },
          { type: "tool-input-end", id: "tool-1" },
          { type: "text-start", id: "text-after" },
          { type: "text-delta", id: "text-after", text: "done" },
          { type: "text-end", id: "text-after" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]),
      ),
    );

    expect(
      frames
        .filter((frame) => frame.event === "content_block_start")
        .map((frame) => (frame.data as { index: number }).index),
    ).toEqual([0, 1, 2]);
    expect(
      frames
        .filter((frame) => frame.event === "content_block_stop")
        .map((frame) => (frame.data as { index: number }).index),
    ).toEqual([0, 1, 2]);
  });

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

    const frames = await collectSSEFrames(writeAnthropicMessagesSSE(stream));
    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(frames[0]?.data).toMatchObject({
      type: "message_start",
      message: { id: "msg-test", model: "test-model", container: null, stop_details: null },
    });
    expect(frames[5]?.data).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { input_tokens: 3, output_tokens: 2 },
    });
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

    const frames = await collectSSEFrames(writeAnthropicMessagesSSE(stream));
    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(frames[2]?.data).toMatchObject({ delta: { type: "text_delta", text: "safe" } });
  });

  test("Given tool input stream When encoded Then emits Anthropic tool_use SSE", async () => {
    const frames = await collectSSEFrames(writeAnthropicMessagesSSE(partStream(toolParts)));
    expect(frames[1]?.data).toMatchObject({
      type: "content_block_start",
      content_block: { type: "tool_use", id: "tool-1", name: "weather", caller: { type: "direct" } },
    });
    expect(frames[4]?.data).toMatchObject({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { input_tokens: 3, output_tokens: 4 },
    });
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
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "", citations: null } },
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "tool-1", name: "weather", input: {}, caller: { type: "direct" } },
      },
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "tool-2", name: "clock", input: {}, caller: { type: "direct" } },
      },
      { type: "content_block_start", index: 3, content_block: { type: "text", text: "", citations: null } },
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

  test("Given duplicate and stale text lifecycle events When encoded Then blocks start and stop once", async () => {
    const frames = await collectSSEFrames(
      writeAnthropicMessagesSSE(
        partStream([
          { type: "text-start", id: "text-old" },
          { type: "text-start", id: "text-old" },
          { type: "text-end", id: "text-old" },
          { type: "text-start", id: "text-current" },
          { type: "text-start", id: "text-old" },
          { type: "text-end", id: "text-old" },
          { type: "text-delta", id: "text-current", text: "current" },
          { type: "text-end", id: "text-current" },
          { type: "text-end", id: "text-current" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]),
      ),
    );

    expect(
      frames
        .filter((frame) => frame.event === "content_block_start")
        .map((frame) => (frame.data as { index: number }).index),
    ).toEqual([0, 1]);
    expect(
      frames
        .filter((frame) => frame.event === "content_block_stop")
        .map((frame) => (frame.data as { index: number }).index),
    ).toEqual([0, 1]);
    expect(frames.find((frame) => frame.event === "content_block_delta")?.data).toEqual({
      type: "content_block_delta",
      index: 1,
      delta: { type: "text_delta", text: "current" },
    });
  });
});
