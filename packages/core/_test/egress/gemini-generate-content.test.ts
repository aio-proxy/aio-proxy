import { describe, expect, test } from "bun:test";
import type { TextStreamPart, ToolSet } from "ai";
import {
  writeGeminiGenerateContentResponse as writeGeminiGenerateContentResponseRaw,
  writeGeminiGenerateContentSSE as writeGeminiGenerateContentSSERaw,
} from "../../src/index";

const defaultEgress = { modelId: "test-model" };
const writeGeminiGenerateContentResponse = (
  stream: Parameters<typeof writeGeminiGenerateContentResponseRaw>[0],
  context = defaultEgress,
) => writeGeminiGenerateContentResponseRaw(stream, context);
const writeGeminiGenerateContentSSE = (
  stream: Parameters<typeof writeGeminiGenerateContentSSERaw>[0],
  context = defaultEgress,
) => writeGeminiGenerateContentSSERaw(stream, context);

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
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

type GeminiFrame = {
  readonly candidates: readonly {
    readonly content: { readonly parts: readonly unknown[] };
    readonly finishReason?: string;
  }[];
  readonly modelVersion: string;
  readonly responseId: string;
  readonly usageMetadata?: Record<string, number>;
};

describe("Gemini generateContent egress", () => {
  test("Given finish-step metadata When encoded as response Then upstream response metadata is reused", async () => {
    const response = await writeGeminiGenerateContentResponse(
      runtimePartStream([
        { type: "text-delta", id: "text-1", text: "Hello" },
        {
          type: "finish-step",
          response: {
            id: "gemini-upstream-id",
            modelId: "gemini-upstream-model",
            timestamp: new Date("2026-07-12T00:00:05.000Z"),
          },
        },
        { type: "finish", finishReason: "stop", totalUsage: {} },
      ]) as never,
      { modelId: "gemini-fallback" },
    );

    expect(response).toMatchObject({ responseId: "gemini-upstream-id", modelVersion: "gemini-upstream-model" });
  });

  test("Given independent streams When encoded Then chunks share one local id and resolved model", async () => {
    const encode = async () => {
      const value = await collectSSE(
        writeGeminiGenerateContentSSE(
          partStream([
            { type: "text-delta", id: "text-1", text: "Hello" },
            { type: "finish", finishReason: "stop", rawFinishReason: "STOP", totalUsage: {} },
          ]),
          { modelId: "gemini-routed" },
        ),
      );
      return value
        .trim()
        .split("\n\n")
        .map((frame) => JSON.parse(frame.slice("data: ".length)) as { responseId: string; modelVersion: string });
    };

    const [first, second] = await Promise.all([encode(), encode()]);
    expect(new Set(first.map((frame) => frame.responseId)).size).toBe(1);
    expect(first[0]?.responseId).not.toBe(second[0]?.responseId);
    expect(first.every((frame) => frame.modelVersion === "gemini-routed")).toBe(true);
  });

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

    await expect(writeGeminiGenerateContentResponse(stream)).resolves.toMatchObject({
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
      modelVersion: "test-model",
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

    await expect(writeGeminiGenerateContentResponse(stream)).resolves.toMatchObject({
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
      modelVersion: "test-model",
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

    const frames = (await collectSSE(writeGeminiGenerateContentSSE(stream)))
      .trim()
      .split("\n\n")
      .map((frame) => JSON.parse(frame.slice("data: ".length)) as GeminiFrame);
    expect(frames.map((frame) => frame.candidates[0].content.parts)).toEqual([[{ text: "Hel" }], [{ text: "lo" }], []]);
    expect(frames[2]).toMatchObject({
      modelVersion: "test-model",
      candidates: [{ finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    });
  });
});
