import type { OpenRouterPriceCatalog, TextStreamPart, ToolSet } from "@aio-proxy/core";

import { createRequestLogStore, openDb, requestLog, usage } from "@aio-proxy/core/db";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRequestRecorder } from "../request-recorder";
import { createUsageCapture } from "./index";

const homes: string[] = [];
const fixedNow = new Date("2026-07-11T08:00:00.000Z");

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-usage-capture-"));
  homes.push(home);
  return home;
}

function textStream(parts: readonly TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

function finishPart(): TextStreamPart<ToolSet> {
  return {
    type: "finish",
    finishReason: "stop",
    rawFinishReason: "stop",
    totalUsage: {
      inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: 1, noCacheTokens: 1 },
      inputTokens: 4,
      outputTokenDetails: { reasoningTokens: 3, textTokens: 3 },
      outputTokens: 6,
      totalTokens: 10,
    },
  };
}

async function drain<T>(stream: ReadableStream<T>): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const value of stream) {
    values.push(value);
  }
  return values;
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("usage capture", () => {
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

  test("passthrough preserves response metadata and bytes while parsing and pricing usage", async () => {
    const body = JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    const catalog: OpenRouterPriceCatalog = {
      find: () => ({ id: "priced/model", input: 2, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 }),
    };
    const captured = createUsageCapture({
      priceCatalogTask: async () => catalog,
    }).passthrough({
      response: new Response(body, {
        headers: { "content-type": "application/json", "x-upstream": "yes" },
        status: 200,
        statusText: "Good",
      }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "model",
    });

    expect(captured.value.status).toBe(200);
    expect(captured.value.statusText).toBe("Good");
    expect(captured.value.headers.get("x-upstream")).toBe("yes");
    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({
      outcome: "success",
      statusCode: 200,
      usage: expect.objectContaining({
        inputTokens: 3,
        outputTokens: 2,
        priceModelId: "priced/model",
        estimatedCostUsd: expect.closeTo(0.000026),
      }),
    });
  });

  test("oversized JSON passthrough stays byte-identical and skips usage observation", async () => {
    const body = JSON.stringify({
      padding: "x".repeat(2 * 1024 * 1024),
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response: new Response(body, { headers: { "content-type": "application/json" } }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "model",
    });

    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({ outcome: "success", statusCode: 200 });
  });

  test("oversized SSE event disables observation without interrupting passthrough", async () => {
    const body =
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
      `data: ${"x".repeat(2 * 1024 * 1024)}\n\n`;
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "model",
    });

    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({ outcome: "success", statusCode: 200 });
  });

  test("SSE observation handles UTF-8 and CRLF split across chunks", async () => {
    const body = 'data:{"content":"🙂","usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\r\n\r\n';
    const bytes = new TextEncoder().encode(body);
    const emojiStart = bytes.indexOf(0xf0);
    const carriageReturn = bytes.indexOf(0x0d);
    const chunks = [
      bytes.slice(0, emojiStart + 2),
      bytes.slice(emojiStart + 2, carriageReturn + 1),
      bytes.slice(carriageReturn + 1),
    ];
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response: new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(chunk);
            }
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "model",
    });

    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({
      outcome: "success",
      statusCode: 200,
      usage: expect.objectContaining({ inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
    });
  });

  test("passthrough consumer cancellation forwards the reason and completes as cancelled", async () => {
    const firstChunk = new TextEncoder().encode("first");
    const cleanupError = new Error("test cleanup");
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    let cancelledReason: unknown;
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response: new Response(
        new ReadableStream({
          start(controller) {
            sourceController = controller;
            controller.enqueue(firstChunk);
          },
          cancel(reason) {
            cancelledReason = reason;
          },
        }),
        { headers: { "x-upstream": "yes" }, status: 200, statusText: "Good" },
      ),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "model",
    });
    const body = captured.value.body;
    if (body === null) {
      throw new Error("expected passthrough response body");
    }
    const reader = body.getReader();
    const reason = new Error("consumer stopped");

    expect(captured.value.status).toBe(200);
    expect(captured.value.statusText).toBe("Good");
    expect(captured.value.headers.get("x-upstream")).toBe("yes");
    expect(await reader.read()).toEqual({ done: false, value: firstChunk });
    const cancellation = reader.cancel(reason);
    await Promise.resolve();
    if (cancelledReason === undefined) {
      sourceController.error(cleanupError);
    }
    await cancellation.catch(() => undefined);

    expect(cancelledReason).toBe(reason);
    await expect(captured.completion).resolves.toEqual({ outcome: "cancelled", statusCode: 200 });
  });

  test("passthrough body errors remain visible and complete as failure", async () => {
    const expected = new Error("upstream body broke");
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
            controller.error(expected);
          },
        }),
        { status: 200 },
      ),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "model",
    });

    await expect(captured.value.text()).rejects.toBe(expected);
    await expect(captured.completion).resolves.toEqual({ outcome: "failure", statusCode: 200 });
  });

  test("non-success passthrough completes immediately as failure without consuming the body", async () => {
    const response = new Response("rate limited", { status: 429 });
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response,
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "model",
    });

    expect(captured.value).toBe(response);
    expect(await captured.value.text()).toBe("rate limited");
    await expect(captured.completion).resolves.toEqual({ outcome: "failure", statusCode: 429 });
  });

  test("empty or unparseable passthrough usage does not create a usage row", async () => {
    for (const body of [JSON.stringify({ usage: {} }), "data: {not-json}\n\n"]) {
      const handle = openDb({ home: tempHome() });
      const recorder = createRequestRecorder({ store: createRequestLogStore(handle.db), now: () => fixedNow });
      const session = recorder.begin({ inboundProtocol: "openai-compatible", requestedModelId: "mini" });
      const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
        response: new Response(body),
        protocol: ProviderProtocol.OpenAICompatible,
        providerId: "provider",
        modelId: "model",
      });
      session.finishFrom(
        {
          providerId: "provider",
          modelId: "model",
          providerKind: ProviderKind.Api,
          protocol: ProviderProtocol.OpenAICompatible,
          durationMs: 1,
        },
        captured.completion,
      );

      await captured.value.text();
      await captured.completion;
      await settle();

      expect(handle.db.select().from(requestLog).all()).toHaveLength(1);
      expect(handle.db.select().from(usage).all()).toEqual([]);
      handle.close();
    }
  });

  test("ai-sdk Gemini-shaped usage does not double-count unpriced thoughts", async () => {
    const catalog: OpenRouterPriceCatalog = {
      find: () => ({ id: "google/gemini", input: 1, output: 2 }),
    };
    const finish: TextStreamPart<ToolSet> = {
      type: "finish",
      finishReason: "stop",
      rawFinishReason: "stop",
      totalUsage: {
        inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined, noCacheTokens: 10 },
        inputTokens: 10,
        outputTokenDetails: { reasoningTokens: 50, textTokens: 100 },
        outputTokens: 150,
        totalTokens: 160,
      },
    };
    const captured = createUsageCapture({ priceCatalogTask: async () => catalog }).stream({
      providerId: "provider",
      modelId: "gemini",
      stream: textStream([finish]),
    });
    await drain(captured.value);
    await expect(captured.completion).resolves.toEqual({
      outcome: "success",
      usage: expect.objectContaining({
        inputTokens: 10,
        outputTokens: 150,
        reasoningTokens: 50,
        // (10*1 + 150*2) / 1e6 — reasoning not added again
        estimatedCostUsd: 0.00031,
        priceModelId: "google/gemini",
      }),
    });
  });

  test("ai-sdk Anthropic-shaped usage peels priced cache read and write once", async () => {
    const catalog: OpenRouterPriceCatalog = {
      find: () => ({ id: "anthropic/claude", input: 2, output: 10, cacheRead: 0.5, cacheWrite: 3 }),
    };
    const finish: TextStreamPart<ToolSet> = {
      type: "finish",
      finishReason: "stop",
      rawFinishReason: "stop",
      totalUsage: {
        inputTokenDetails: { cacheReadTokens: 40, cacheWriteTokens: 10, noCacheTokens: 50 },
        inputTokens: 100,
        outputTokenDetails: { reasoningTokens: undefined, textTokens: 20 },
        outputTokens: 20,
        totalTokens: 120,
      },
    };
    const captured = createUsageCapture({ priceCatalogTask: async () => catalog }).stream({
      providerId: "provider",
      modelId: "claude",
      stream: textStream([finish]),
    });
    await drain(captured.value);
    await expect(captured.completion).resolves.toEqual({
      outcome: "success",
      usage: expect.objectContaining({
        inputTokens: 100,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        // billable input 50: (50*2 + 20*10 + 40*0.5 + 10*3) / 1e6
        estimatedCostUsd: 0.00035,
        priceModelId: "anthropic/claude",
      }),
    });
  });

  test("passthrough OpenAI SSE keeps raw input and peels priced cache", async () => {
    const body = [
      'data: {"id":"chatcmpl-2","choices":[{"index":0,"delta":{"content":"Hi"}}]}',
      "",
      'data: {"id":"chatcmpl-2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2006,"completion_tokens":300,"total_tokens":2306,"prompt_tokens_details":{"cached_tokens":1920}}}',
      "",
      "data: [DONE]",
    ].join("\n");
    const catalog: OpenRouterPriceCatalog = {
      find: () => ({ id: "openai/gpt-test", input: 2, output: 10, cacheRead: 0.5 }),
    };
    const captured = createUsageCapture({ priceCatalogTask: async () => catalog }).passthrough({
      response: new Response(body, { headers: { "content-type": "text/event-stream" } }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "gpt",
    });
    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({
      outcome: "success",
      statusCode: 200,
      usage: expect.objectContaining({
        inputTokens: 2006,
        cacheReadTokens: 1920,
        outputTokens: 300,
        estimatedCostUsd: 0.004132,
        priceModelId: "openai/gpt-test",
      }),
    });
  });

  test("passthrough OpenAI without cacheRead price does not undercharge", async () => {
    const body = JSON.stringify({
      usage: {
        prompt_tokens: 2006,
        completion_tokens: 300,
        total_tokens: 2306,
        prompt_tokens_details: { cached_tokens: 1920 },
      },
    });
    const catalog: OpenRouterPriceCatalog = {
      find: () => ({ id: "openai/gpt-test", input: 2, output: 10 }),
    };
    const captured = createUsageCapture({ priceCatalogTask: async () => catalog }).passthrough({
      response: new Response(body, { headers: { "content-type": "application/json" } }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: "provider",
      modelId: "gpt",
    });
    await captured.value.text();
    await expect(captured.completion).resolves.toEqual({
      outcome: "success",
      statusCode: 200,
      usage: expect.objectContaining({
        inputTokens: 2006,
        cacheReadTokens: 1920,
        estimatedCostUsd: 0.007012,
      }),
    });
  });
});
