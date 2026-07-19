import type { OpenRouterPriceCatalog, TextStreamPart, ToolSet } from "@aio-proxy/core";

import { describe, expect, test } from "bun:test";

import { createUsageCapture } from "./index";
import { drain, finishPart, settle, textStream } from "./test-support";

describe("usage capture stream", () => {
  test("model stream reads stay bounded by downstream demand", async () => {
    let pulls = 0;
    let index = 0;
    const parts = [
      { type: "text-delta", id: "text-1", text: "one" },
      { type: "text-delta", id: "text-1", text: "two" },
      { type: "text-delta", id: "text-1", text: "three" },
    ] as const satisfies readonly TextStreamPart<ToolSet>[];
    const source = new ReadableStream<TextStreamPart<ToolSet>>({
      pull(controller) {
        pulls += 1;
        const part = parts[index];
        index += 1;
        if (part === undefined) controller.close();
        else controller.enqueue(part);
      },
    });
    await settle();
    const beforeCapture = pulls;
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).stream({
      providerId: "provider",
      modelId: "model",
      stream: source,
    });

    await settle();
    expect(pulls).toBeLessThan(parts.length);
    expect(pulls).toBeLessThanOrEqual(beforeCapture + 1);
    const reader = captured.value.getReader();
    for (const part of parts) {
      const before = pulls;
      expect(await reader.read()).toEqual({ done: false, value: part });
      await settle();
      expect(pulls).toBeLessThanOrEqual(before + 1);
    }
    await reader.cancel();
  });

  test("a stream that sends data then errors is failure and preserves the error", async () => {
    const expected = new Error("upstream broke");
    const capture = createUsageCapture({ priceCatalogTask: async () => undefined });
    const captured = capture.stream({
      providerId: "provider",
      modelId: "model",
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-delta", id: "text-1", text: "hello" });
          controller.error(expected);
        },
      }),
    });

    await expect(drain(captured.value)).rejects.toBe(expected);
    await expect(captured.completion).resolves.toEqual({ outcome: "failure" });
  });

  test("an upstream AbortError is cancelled and remains visible to the consumer", async () => {
    const expected = new Error("upstream aborted");
    expected.name = "AbortError";
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).stream({
      providerId: "provider",
      modelId: "model",
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "text-delta", id: "text-1", text: "hello" });
          controller.error(expected);
        },
      }),
    });

    await expect(drain(captured.value)).rejects.toBe(expected);
    await expect(captured.completion).resolves.toEqual({ outcome: "cancelled" });
  });

  test("a stream without a finish part is failure", async () => {
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).stream({
      providerId: "provider",
      modelId: "model",
      stream: textStream([{ type: "text-delta", id: "text-1", text: "hello" }]),
    });

    expect(await drain(captured.value)).toEqual([{ type: "text-delta", id: "text-1", text: "hello" }]);
    await expect(captured.completion).resolves.toEqual({ outcome: "failure" });
  });

  test("an abort part cancels a normally closed stream and remains visible", async () => {
    const parts = [
      { type: "text-delta", id: "text-1", text: "hello" },
      { type: "abort" },
    ] as const satisfies readonly TextStreamPart<ToolSet>[];
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).stream({
      providerId: "provider",
      modelId: "model",
      stream: textStream(parts),
    });

    expect(await drain(captured.value)).toEqual(parts);
    await expect(captured.completion).resolves.toEqual({ outcome: "cancelled" });
  });

  test("a normally closed stream with finish is success and priced before completion", async () => {
    const catalog: OpenRouterPriceCatalog = {
      find: () => ({ id: "priced/model", input: 2, output: 10, cacheRead: 3, cacheWrite: 4, reasoning: 5 }),
    };
    const captured = createUsageCapture({ priceCatalogTask: async () => catalog }).stream({
      providerId: "provider",
      modelId: "model",
      stream: textStream([finishPart()]),
    });

    expect(await drain(captured.value)).toEqual([finishPart()]);
    await expect(captured.completion).resolves.toEqual({
      outcome: "success",
      usage: {
        providerId: "provider",
        modelId: "model",
        inputTokens: 4,
        outputTokens: 6,
        totalTokens: 10,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        reasoningTokens: 3,
        priceModelId: "priced/model",
        estimatedCostUsd: 0.000057,
      },
    });
  });

  test("consumer cancellation resolves cancelled", async () => {
    let cancelled = false;
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).stream({
      providerId: "provider",
      modelId: "model",
      stream: new ReadableStream({
        pull(controller) {
          controller.enqueue({ type: "text-delta", id: "text-1", text: "hello" });
        },
        cancel() {
          cancelled = true;
        },
      }),
    });
    const reader = captured.value.getReader();

    await reader.read();
    await reader.cancel();

    expect(cancelled).toBe(true);
    await expect(captured.completion).resolves.toEqual({ outcome: "cancelled" });
  });

  test("pricing failures do not alter stream parts", async () => {
    const parts = [{ type: "text-delta", id: "text-1", text: "hello" }, finishPart()] as const;
    const captured = createUsageCapture({
      priceCatalogTask: async () => {
        throw new Error("pricing unavailable");
      },
    }).stream({ providerId: "provider", modelId: "model", stream: textStream(parts) });

    expect(await drain(captured.value)).toEqual(parts);
    await expect(captured.completion).resolves.toEqual({
      outcome: "success",
      usage: expect.objectContaining({ providerId: "provider", modelId: "model", inputTokens: 4 }),
    });
  });
});
