import { describe, expect, test } from "bun:test";
import type { TextStreamPart, ToolSet } from "ai";
import {
  writeGeminiGenerateContentResponse,
  writeGeminiGenerateContentSSE,
} from "../../src/index";

async function collectSSE(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();

  for await (const chunk of stream) {
    chunks.push(decoder.decode(chunk, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join("");
}

function partStream(
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

describe("Gemini generateContent egress", () => {
  test("Given text stream When encoded as response Then emits Gemini JSON", async () => {
    const stream = partStream([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "Hel" },
      { type: "text-delta", id: "text-1", text: "lo" },
      { type: "text-end", id: "text-1" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "STOP",
        totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      },
    ]);

    await expect(writeGeminiGenerateContentResponse(stream)).resolves.toEqual({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Hello" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 3,
        candidatesTokenCount: 2,
        totalTokenCount: 5,
      },
    });
  });

  test("Given tool-call stream When encoded as response Then emits Gemini functionCall", async () => {
    const stream = partStream([
      { type: "tool-input-start", id: "call_1", toolName: "lookup" },
      { type: "tool-input-delta", id: "call_1", delta: '{"q":"' },
      { type: "tool-input-delta", id: "call_1", delta: 'pizza"}' },
      { type: "tool-input-end", id: "call_1" },
      {
        type: "finish",
        finishReason: "tool-calls",
        rawFinishReason: "STOP",
        totalUsage: { inputTokens: undefined, outputTokens: 4, totalTokens: 9 },
      },
    ]);

    await expect(writeGeminiGenerateContentResponse(stream)).resolves.toEqual({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "lookup",
                  args: { q: "pizza" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        candidatesTokenCount: 4,
        totalTokenCount: 9,
      },
    });
  });

  test("Given text stream When encoded as SSE Then emits exact Gemini frames", async () => {
    const stream = partStream([
      { type: "text-delta", id: "text-1", text: "Hel" },
      { type: "text-delta", id: "text-1", text: "lo" },
      {
        type: "finish",
        finishReason: "stop",
        rawFinishReason: "STOP",
        totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      },
    ]);

    await expect(
      collectSSE(writeGeminiGenerateContentSSE(stream)),
    ).resolves.toBe(
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]}}]}\n\n' +
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]}}]}\n\n' +
        'data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}\n\n',
    );
  });
});
