import { describe, expect, test } from "bun:test";
import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import type { TextStreamPart, ToolSet } from "ai";
import { writeOpenAIResponsesResponse, writeOpenAIResponsesSSE } from "../../src/index";

async function collectSSE(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();

  for await (const chunk of stream) {
    chunks.push(decoder.decode(chunk, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join("");
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

    await expect(collectSSE(writeOpenAIResponsesSSE(stream))).resolves.toBe(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-aio-proxy","object":"response","status":"in_progress","output":[]}}\n\n' +
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs-aio-proxy","type":"reasoning","summary":[]}}\n\n' +
        'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":0,"delta":"I should answer."}\n\n' +
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":1,"item":{"id":"msg-aio-proxy","type":"message","role":"assistant","content":[]}}\n\n' +
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":"Pong"}\n\n' +
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-aio-proxy","object":"response","status":"completed","output":[{"id":"rs-aio-proxy","type":"reasoning","summary":[{"type":"summary_text","text":"I should answer."}]},{"id":"msg-aio-proxy","type":"message","role":"assistant","content":[{"type":"output_text","text":"Pong"}]}],"usage":{"input_tokens":3,"output_tokens":4,"total_tokens":7}}}\n\n',
    );
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

    await expect(collectSSE(writeOpenAIResponsesSSE(stream))).resolves.toBe(
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp-aio-proxy","object":"response","status":"in_progress","output":[]}}\n\n' +
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs-aio-proxy","type":"reasoning","summary":[]}}\n\n' +
        'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":0,"delta":"private summary"}\n\n' +
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp-aio-proxy","object":"response","status":"completed","output":[{"id":"rs-aio-proxy","type":"reasoning","summary":[{"type":"summary_text","text":"private summary"}]}]}}\n\n',
    );
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

    await expect(writeOpenAIResponsesResponse(stream)).resolves.toEqual({
      id: "resp-aio-proxy",
      object: "response",
      status: "completed",
      output: [
        {
          id: "rs-aio-proxy",
          type: "reasoning",
          summary: [{ type: "summary_text", text: "summary" }],
        },
        {
          id: "msg-aio-proxy",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Answer" }],
        },
      ],
      usage: { output_tokens: 2 },
    });
  });
});
