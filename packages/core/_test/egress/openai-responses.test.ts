import { describe, expect, test } from "bun:test";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import type { TextStreamPart, ToolSet } from "ai";
import {
  writeOpenAIResponsesResponse as writeOpenAIResponsesResponseRaw,
  writeOpenAIResponsesSSE as writeOpenAIResponsesSSERaw,
} from "../../src/index";

const defaultEgress = { modelId: "test-model" };
const writeOpenAIResponsesResponse = (
  stream: Parameters<typeof writeOpenAIResponsesResponseRaw>[0],
  context = defaultEgress,
) => writeOpenAIResponsesResponseRaw(stream, context);
const writeOpenAIResponsesSSE = (stream: Parameters<typeof writeOpenAIResponsesSSERaw>[0], context = defaultEgress) =>
  writeOpenAIResponsesSSERaw(stream, context);

async function collectSSE(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();

  for await (const chunk of stream) {
    chunks.push(decoder.decode(chunk, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}

type ResponseEvent = {
  readonly type: string;
  readonly sequence_number: number;
  readonly item_id?: string;
  readonly item?: { readonly id: string; readonly type: string };
  readonly response?: {
    readonly id: string;
    readonly model: string;
    readonly output: readonly Record<string, unknown>[];
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
};

async function frames(stream: ReadableStream<Uint8Array>) {
  return (await collectSSE(stream))
    .trim()
    .split("\n\n")
    .map((frame) => JSON.parse(frame.split("\n")[1]?.slice("data: ".length) ?? "null") as ResponseEvent);
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

describe("OpenAI Responses egress", () => {
  test("Given finish-step metadata When encoded as JSON Then upstream response metadata is reused", async () => {
    const response = await writeOpenAIResponsesResponse(
      aiSdkPartStream([
        { type: "text-delta", id: "text-1", text: "Answer" },
        {
          type: "finish-step",
          response: {
            id: "resp_upstream",
            modelId: "gpt-upstream",
            timestamp: new Date("2026-07-12T00:00:05.000Z"),
          },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          performance: { currentTimestamp: 0 },
          finishReason: "stop",
          rawFinishReason: "stop",
          providerMetadata: undefined,
        },
        { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: {} },
      ]),
      { modelId: "gpt-fallback" },
    );

    expect(response).toMatchObject({ id: "resp_upstream", model: "gpt-upstream", created_at: 1_783_814_405 });
    expect(response.output[0]?.id).toBe("msg_resp_upstream_0");
  });

  test("Given independent response streams When encoded Then ids are unique and event references are consistent", async () => {
    const encode = () =>
      frames(
        writeOpenAIResponsesSSE(
          aiSdkPartStream([
            { type: "reasoning-delta", id: "reason-1", text: "think" },
            { type: "text-delta", id: "text-1", text: "answer" },
            { type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: {} },
          ]),
          { modelId: "gpt-routed" },
        ),
      );

    const [first, second] = await Promise.all([encode(), encode()]);
    const responseId = first[0]?.response.id as string;
    const reasoningId = first.find((event) => event.item?.type === "reasoning")?.item.id as string;
    const messageId = first.find((event) => event.item?.type === "message")?.item.id as string;

    expect(responseId).toStartWith("resp_");
    expect(responseId).not.toBe(second[0]?.response.id);
    expect(first.map((event) => event.sequence_number)).toEqual(first.map((_, index) => index));
    expect(first.find((event) => event.type === "response.reasoning_summary_text.delta")?.item_id).toBe(reasoningId);
    expect(first.find((event) => event.type === "response.output_text.delta")?.item_id).toBe(messageId);
    expect(first.at(-1)?.response).toMatchObject({ id: responseId, model: "gpt-routed" });
  });

  test("Given reasoning stream parts When encoded Then emits exact Responses SSE events", async () => {
    const stream = aiSdkPartStream([
      { type: "reasoning-start", id: "reason-1" },
      { type: "reasoning-delta", id: "reason-1", text: "I should answer." },
      { type: "reasoning-end", id: "reason-1" },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "Pong" },
      { type: "text-end", id: "text-1" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
    ]);

    const events = await frames(writeOpenAIResponsesSSE(stream));
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.reasoning_summary_text.delta",
      "response.output_item.added",
      "response.output_text.delta",
      "response.completed",
    ]);
    expect(events[2]).toMatchObject({ delta: "I should answer.", summary_index: 0 });
    expect(events[4]).toMatchObject({ delta: "Pong", content_index: 0, logprobs: [] });
    expect(events[5]?.response).toMatchObject({
      status: "completed",
      output_text: "Pong",
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
    });
  });

  test("Given Anthropic-style provider stream When encoded Then reasoning delta maps without metadata", async () => {
    const stream = partStream([
      {
        type: "reasoning-delta",
        id: "reason-1",
        delta: "private summary",
        providerMetadata: {
          anthropic: {
            signature: "sig",
            encrypted: "cipher",
          },
        },
      },
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

    const events = await frames(writeOpenAIResponsesSSE(stream));
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.output_item.added",
      "response.reasoning_summary_text.delta",
      "response.completed",
    ]);
    expect(events[2]).toMatchObject({ delta: "private summary" });
    expect(events[3]?.response.output[0]).toMatchObject({
      type: "reasoning",
      summary: [{ type: "summary_text", text: "private summary" }],
    });
  });

  test("Given accumulated text and reasoning When encoded as JSON Then Responses object is returned", async () => {
    const stream = aiSdkPartStream([
      { type: "reasoning-delta", id: "reason-1", text: "summary" },
      { type: "text-delta", id: "text-1", text: "Answer" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "stop",
        totalUsage: {
          inputTokens: undefined,
          outputTokens: 2,
          totalTokens: undefined,
        },
      },
    ]);

    await expect(writeOpenAIResponsesResponse(stream)).resolves.toMatchObject({
      object: "response",
      status: "completed",
      output: [
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "summary" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Answer", annotations: [] }],
        },
      ],
      output_text: "Answer",
      model: "test-model",
      usage: { input_tokens: 0, output_tokens: 2, total_tokens: 2 },
    });
  });
});
