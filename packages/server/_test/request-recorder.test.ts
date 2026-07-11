import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenRouterPriceCatalog, TextStreamPart, ToolSet } from "@aio-proxy/core";
import { createRequestLogStore, openDb, type RequestLogStore, requestLog, usage } from "@aio-proxy/core/db";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { createRequestRecorder, type RequestSession } from "../src/request-recorder";
import { createUsageCapture } from "../src/usage-capture";

const homes: string[] = [];
const fixedNow = new Date("2026-07-11T08:00:00.000Z");

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-request-recorder-"));
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

describe("request recorder", () => {
  test("records one request with failed fallback and one successful final usage row", () => {
    const handle = openDb({ home: tempHome() });
    const recorder = createRequestRecorder({
      store: createRequestLogStore(handle.db),
      now: () => fixedNow,
    });
    const request = recorder.begin({
      inboundProtocol: "openai-compatible",
      requestedModelId: "mini",
    });

    request.attempt({
      providerId: "primary",
      modelId: "gpt-5",
      providerKind: ProviderKind.Api,
      protocol: ProviderProtocol.OpenAICompatible,
      outcome: "failure",
      statusCode: 429,
      durationMs: 10,
    });
    request.finish({
      outcome: "success",
      finalProviderId: "backup",
      finalModelId: "openai/gpt-5",
      finalStatusCode: 200,
      attempt: {
        providerId: "backup",
        modelId: "openai/gpt-5",
        providerKind: ProviderKind.Api,
        protocol: ProviderProtocol.OpenAICompatible,
        outcome: "success",
        statusCode: 200,
        durationMs: 20,
      },
      usage: {
        providerId: "backup",
        modelId: "openai/gpt-5",
        inputTokens: 4,
        outputTokens: 6,
        totalTokens: 10,
      },
    });

    expect(handle.db.select().from(requestLog).all()).toEqual([
      expect.objectContaining({
        requestId: request.requestId,
        outcome: "success",
        finalProviderId: "backup",
        finalModelId: "openai/gpt-5",
        attempts: [
          expect.objectContaining({ providerId: "primary", index: 0, outcome: "failure" }),
          expect.objectContaining({ providerId: "backup", index: 1, outcome: "success" }),
        ],
      }),
    ]);
    expect(handle.db.select().from(usage).all()).toEqual([
      expect.objectContaining({ requestId: request.requestId, inputTokens: 4, outputTokens: 6 }),
    ]);
    handle.close();
  });

  test.each(["failure", "cancelled"] as const)("a %s request inserts no usage", (outcome) => {
    const handle = openDb({ home: tempHome() });
    const request = createRequestRecorder({
      store: createRequestLogStore(handle.db),
      now: () => fixedNow,
    }).begin({ inboundProtocol: "anthropic", requestedModelId: "mini" });

    request.finish({ outcome });

    expect(handle.db.select().from(requestLog).all()).toEqual([expect.objectContaining({ outcome })]);
    expect(handle.db.select().from(usage).all()).toEqual([]);
    handle.close();
  });

  test("calling finish twice inserts once", () => {
    const handle = openDb({ home: tempHome() });
    const request = createRequestRecorder({
      store: createRequestLogStore(handle.db),
      now: () => fixedNow,
    }).begin({ inboundProtocol: "gemini", requestedModelId: "mini" });

    request.finish({ outcome: "failure", errorCode: "first" });
    request.finish({ outcome: "success", finalProviderId: "late", finalModelId: "late" });

    expect(handle.db.select().from(requestLog).all()).toEqual([
      expect.objectContaining({ outcome: "failure", errorCode: "first" }),
    ]);
    handle.close();
  });

  test("persistence failures are swallowed", () => {
    const store: RequestLogStore = {
      insertFinal() {
        throw new Error("database unavailable");
      },
      overview() {
        throw new Error("unused");
      },
      prune() {
        throw new Error("database unavailable");
      },
    };
    const request = createRequestRecorder({ store, now: () => fixedNow }).begin({
      inboundProtocol: "openai-compatible",
      requestedModelId: "mini",
    });

    expect(() => request.finish({ outcome: "success" })).not.toThrow();
  });

  test("a logger failure cannot escape constructor pruning", () => {
    const store: RequestLogStore = {
      insertFinal() {},
      overview() {
        throw new Error("unused");
      },
      prune() {
        throw new Error("database unavailable");
      },
    };

    expect(() =>
      createRequestRecorder({
        store,
        now: () => fixedNow,
        logger() {
          throw new Error("logger unavailable");
        },
      }),
    ).not.toThrow();
  });

  test("a logger failure cannot escape lazy pruning or finish persistence", () => {
    let current = fixedNow;
    let pruneCalls = 0;
    const store: RequestLogStore = {
      insertFinal() {
        throw new Error("database unavailable");
      },
      overview() {
        throw new Error("unused");
      },
      prune() {
        pruneCalls += 1;
        if (pruneCalls > 1) {
          throw new Error("database unavailable");
        }
      },
    };
    const recorder = createRequestRecorder({
      store,
      now: () => current,
      logger() {
        throw new Error("logger unavailable");
      },
    });
    current = new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000);
    let request: RequestSession | undefined;

    expect(() => {
      request = recorder.begin({ inboundProtocol: "anthropic", requestedModelId: "mini" });
    }).not.toThrow();
    expect(request).toBeDefined();
    expect(() => request?.finish({ outcome: "failure" })).not.toThrow();
  });

  test("prunes on construction and at most once per 24 hours", () => {
    let current = fixedNow;
    const cutoffs: Date[] = [];
    const store: RequestLogStore = {
      insertFinal() {},
      overview() {
        throw new Error("unused");
      },
      prune(cutoff) {
        cutoffs.push(cutoff);
      },
    };
    const recorder = createRequestRecorder({ store, now: () => current });

    recorder.begin({ inboundProtocol: "openai-compatible", requestedModelId: "one" });
    current = new Date(fixedNow.getTime() + 23 * 60 * 60 * 1000);
    recorder.begin({ inboundProtocol: "openai-compatible", requestedModelId: "two" });
    current = new Date(fixedNow.getTime() + 24 * 60 * 60 * 1000);
    recorder.begin({ inboundProtocol: "openai-compatible", requestedModelId: "three" });

    expect(cutoffs).toEqual([
      new Date(fixedNow.getTime() - 45 * 24 * 60 * 60 * 1000),
      new Date(fixedNow.getTime() - 44 * 24 * 60 * 60 * 1000),
    ]);
  });
});

describe("usage capture", () => {
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
        estimatedCostUsd: 0.000093,
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
});
