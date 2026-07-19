import { describe, expect, test } from "bun:test";

import type { TextStreamPart, ToolSet } from "../ai-sdk-bridge";

import { writeOpenAIResponsesResponse, writeOpenAIResponsesSSE } from "./openai-responses";

describe("OpenAI Responses response-chain callbacks", () => {
  test("JSON commits the completed response ID exactly once", async () => {
    const ids: string[] = [];
    const response = await writeOpenAIResponsesResponse(parts([{ type: "text-delta", id: "text", text: "ok" }]), {
      modelId: "gpt",
      onResponseId: (id) => ids.push(id),
    });

    expect(ids).toEqual([response.id]);
    expect(response.status).toBe("completed");
  });

  test("SSE commits exactly once when response.completed is produced", async () => {
    const ids: string[] = [];
    const stream = writeOpenAIResponsesSSE(parts([{ type: "text-delta", id: "text", text: "ok" }]), {
      modelId: "gpt",
      onResponseId: (id) => ids.push(id),
    });
    expect(ids).toEqual([]);

    const body = await collect(stream);
    const completed = body.split("\n\n").find((frame) => frame.startsWith("event: response.completed\n"));
    const payload = JSON.parse(completed?.split("\n")[1]?.slice("data: ".length) ?? "null") as {
      response: { id: string };
    };
    expect(ids).toEqual([payload.response.id]);
  });

  test("errored JSON and SSE streams never commit a response ID", async () => {
    for (const format of ["json", "sse"] as const) {
      const ids: string[] = [];
      const stream = errorParts(new Error(`${format} failed`));
      const context = { modelId: "gpt", onResponseId: (id: string) => ids.push(id) };
      if (format === "json") {
        await expect(writeOpenAIResponsesResponse(stream, context)).rejects.toThrow("json failed");
      } else {
        await expect(collect(writeOpenAIResponsesSSE(stream, context))).rejects.toThrow("sse failed");
      }
      expect(ids).toEqual([]);
    }
  });

  test("error events reject JSON and SSE without committing a response ID", async () => {
    const error = new Error("event failed");
    for (const format of ["json", "sse"] as const) {
      const ids: string[] = [];
      const stream = parts([{ type: "error", error }]);
      const context = { modelId: "gpt", onResponseId: (id: string) => ids.push(id) };
      if (format === "json") {
        await expect(writeOpenAIResponsesResponse(stream, context)).rejects.toBe(error);
      } else {
        await expect(collect(writeOpenAIResponsesSSE(stream, context))).rejects.toBe(error);
      }
      expect(ids).toEqual([]);
    }
  });

  test("error finish reasons reject JSON and SSE without committing a response ID", async () => {
    for (const format of ["json", "sse"] as const) {
      const ids: string[] = [];
      const stream = parts([
        { type: "finish", finishReason: "error", rawFinishReason: "upstream_error", totalUsage: {} },
      ]);
      const context = { modelId: "gpt", onResponseId: (id: string) => ids.push(id) };
      if (format === "json") {
        await expect(writeOpenAIResponsesResponse(stream, context)).rejects.toThrow("upstream_error");
      } else {
        await expect(collect(writeOpenAIResponsesSSE(stream, context))).rejects.toThrow("upstream_error");
      }
      expect(ids).toEqual([]);
    }
  });

  test("error finish-step reasons reject JSON and SSE without committing a response ID", async () => {
    for (const format of ["json", "sse"] as const) {
      const ids: string[] = [];
      const stream = parts([
        {
          type: "finish-step",
          response: { id: "resp_error", modelId: "gpt", timestamp: new Date(0) },
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          performance: { currentTimestamp: 0 },
          finishReason: "error",
          rawFinishReason: "step_error",
          providerMetadata: undefined,
        },
      ]);
      const context = { modelId: "gpt", onResponseId: (id: string) => ids.push(id) };
      if (format === "json") {
        await expect(writeOpenAIResponsesResponse(stream, context)).rejects.toThrow("step_error");
      } else {
        await expect(collect(writeOpenAIResponsesSSE(stream, context))).rejects.toThrow("step_error");
      }
      expect(ids).toEqual([]);
    }
  });
});

function parts(values: readonly TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
}

function errorParts(error: Error): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: "text-delta", id: "text", text: "partial" });
      controller.error(error);
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return new TextDecoder().decode(Buffer.concat(chunks));
}
