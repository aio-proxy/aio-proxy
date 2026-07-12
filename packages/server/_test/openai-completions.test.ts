import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AiSdkProviderError,
  type AiSdkProviderInstance,
  type ApiProviderInstance,
  createAiSdkProvider,
} from "@aio-proxy/core";
import { openDb, requestLog, usage } from "@aio-proxy/core/db";
import { createServer } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";
import type { CallSettings, ModelMessage, TextStreamPart, ToolSet } from "ai";

const chatRequest = {
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello proxy" }],
  stream: true,
};
const homes: string[] = [];
const nativeFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    String(input) === "https://models.dev/api.json"
      ? Promise.resolve(Response.json({ openrouter: { models: {} } }))
      : nativeFetch(input, init)) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = nativeFetch;
  for (const home of homes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

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

function errorStream(
  error: unknown,
  beforeError: readonly TextStreamPart<ToolSet>[] = [],
): ReadableStream<TextStreamPart<ToolSet>> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      const part = beforeError[index++];
      if (part === undefined) controller.error(error);
      else controller.enqueue(part);
    },
  });
}

class UpstreamStatusError extends Error {
  readonly statusCode = 401;
}

class AbortStreamError extends Error {
  override readonly name = "AbortError";
}

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-openai-usage-"));
  homes.push(home);
  return home;
}

async function usageJson(app: ReturnType<typeof createServer>): Promise<unknown> {
  const usageResponse = await app.request("/dashboard/api/usage?range=24h&metric=tokens&groupBy=provider");
  expect(usageResponse.status).toBe(200);
  return usageResponse.json();
}

async function waitForUsageRow(app: ReturnType<typeof createServer>): Promise<unknown> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const body = await usageJson(app);
    if (
      typeof body === "object" &&
      body !== null &&
      "summary" in body &&
      typeof body.summary === "object" &&
      body.summary !== null &&
      "requestCount" in body.summary &&
      body.summary.requestCount === 1
    ) {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  return usageJson(app);
}

async function recorded(home: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const handle = openDb({ home });
    const requests = handle.db.select().from(requestLog).all();
    const usages = handle.db.select().from(usage).all();
    handle.close();
    if (requests.length > 0) return { requests, usages };
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("request row was not recorded");
}

describe("POST /v1/chat/completions", () => {
  test("Given openai-compatible api provider When completion is posted Then passthrough receives original request", async () => {
    // Given
    let bodySeen: unknown;
    const provider = {
      id: "openai",
      kind: "api",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      async passthrough(req) {
        bodySeen = await req.json();
        return new Response("provider-bytes", {
          headers: { "x-provider": "openai" },
          status: 202,
        });
      },
    } satisfies ApiProviderInstance;
    const dbHome = tempHome();
    const app = createServer({
      config: { providers: {} },
      dbHome,
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify(chatRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(202);
    expect(response.headers.get("x-provider")).toBe("openai");
    expect(await response.text()).toBe("provider-bytes");
    expect(bodySeen).toEqual(chatRequest);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          inboundProtocol: ProviderProtocol.OpenAICompatible,
          requestedModelId: "gpt-4o-mini",
          finalProviderId: "openai",
          finalModelId: "gpt-4o-mini",
          outcome: "success",
          attempts: [expect.objectContaining({ index: 0, providerId: "openai", outcome: "success" })],
        }),
      ],
      usages: [],
    });
  });

  test("Given native response body wraps an inbound AbortError When body fails after headers Then request is cancelled", async () => {
    // Given
    const abort = new AbortController();
    const expected = new AiSdkProviderError("openai", new AbortStreamError("client closed request"));
    let pull = 0;
    const provider = {
      id: "openai",
      kind: "api",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      async passthrough() {
        return new Response(
          new ReadableStream({
            pull(controller) {
              if (pull++ === 0) {
                controller.enqueue(new TextEncoder().encode("partial"));
                abort.abort();
              } else {
                controller.error(expected);
              }
            },
          }),
          { status: 200 },
        );
      },
    } satisfies ApiProviderInstance;
    const dbHome = tempHome();
    const app = createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify(chatRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: abort.signal,
    });

    // Then
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toBe(expected);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          outcome: "cancelled",
          finalStatusCode: 200,
          attempts: [expect.objectContaining({ outcome: "cancelled", statusCode: 200 })],
        }),
      ],
      usages: [],
    });
  });

  test("Given native response body wraps an AbortError without inbound cancellation Then request is failure", async () => {
    const expected = new AiSdkProviderError("openai", new AbortStreamError("upstream aborted"));
    const provider = {
      id: "openai",
      kind: "api",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      passthrough: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
              controller.error(expected);
            },
          }),
          { status: 200 },
        ),
    } satisfies ApiProviderInstance;
    const dbHome = tempHome();
    const app = createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });

    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify(chatRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    await expect(response.text()).rejects.toBe(expected);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          outcome: "failure",
          finalStatusCode: 200,
          attempts: [expect.objectContaining({ outcome: "failure", statusCode: 200 })],
        }),
      ],
      usages: [],
    });
  });

  test("Given an alias variant and native provider When completion is posted Then passthrough receives the variant model", async () => {
    // Given
    let bodySeen: unknown;
    const provider = {
      id: "openai",
      kind: "api",
      models: ["gpt-default", "gpt-high"],
      alias: {
        mini: {
          model: "gpt-default",
          preserve: false,
          variants: { high: { model: "gpt-high", preserve: false } },
        },
      },
      protocol: ProviderProtocol.OpenAICompatible,
      async passthrough(req) {
        bodySeen = await req.json();
        return Response.json({ ok: true });
      },
    } satisfies ApiProviderInstance;
    const app = createServer({ config: { providers: {} }, providerInstances: [provider] });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, model: "mini", reasoning_effort: "high" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(200);
    expect(bodySeen).toEqual({ ...chatRequest, model: "gpt-high", reasoning_effort: "high" });
  });

  test("Given openai-compatible api provider When non-stream completion is posted Then passthrough receives original request", async () => {
    // Given
    let bodySeen: unknown;
    const provider = {
      id: "openai",
      kind: "api",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      async passthrough(req) {
        bodySeen = await req.json();
        return Response.json(
          {
            id: "chatcmpl-upstream",
            object: "chat.completion",
            choices: [],
          },
          { status: 200 },
        );
      },
    } satisfies ApiProviderInstance;
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });
    const request = { ...chatRequest, stream: false };

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body).toEqual({
      id: "chatcmpl-upstream",
      object: "chat.completion",
      choices: [],
    });
    expect(bodySeen).toEqual(request);
  });

  test("Given ai-sdk provider When stream completion is posted Then provider is invoked and OpenAI SSE is returned", async () => {
    // Given
    let messagesSeen: readonly ModelMessage[] | undefined;
    let modelSeen: string | undefined;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke(request) {
        messagesSeen = request.messages;
        modelSeen = request.modelId;
        return textStream([
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", text: "pong" },
          { type: "text-end", id: "text-1" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify(chatRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const text = await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(messagesSeen).toEqual([{ role: "user", content: "Hello proxy" }]);
    expect(modelSeen).toBe("gpt-4o-mini");
    expect(text).toContain("chat.completion.chunk");
    expect(text).toContain('"content":"pong"');
    expect(text).toContain("data: [DONE]");
  });

  test("Given an alias variant and ai-sdk provider When completion is posted Then reasoning selects and configures it", async () => {
    // Given
    let modelSeen: string | undefined;
    let settingsSeen: CallSettings | undefined;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-default", "gpt-high"],
      alias: {
        mini: {
          model: "gpt-default",
          preserve: false,
          variants: { high: { model: "gpt-high", preserve: false } },
        },
      },
      invoke(request) {
        modelSeen = request.modelId;
        settingsSeen = request.settings;
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({ config: { providers: {} }, providerInstances: [provider] });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, model: "mini", reasoning_effort: "high" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(modelSeen).toBe("gpt-high");
    expect(settingsSeen).toEqual({ reasoning: "high", stream: true });
  });

  test("Given ai-sdk provider When non-stream completion is posted Then OpenAI JSON is returned", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        return textStream([
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
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body.id).toStartWith("chatcmpl-");
    expect(body.id).not.toContain("aio-proxy");
    expect(body).toEqual({
      ...body,
      object: "chat.completion",
      choices: [
        {
          finish_reason: "stop",
          index: 0,
          message: { role: "assistant", content: "Hello" },
        },
      ],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
      },
    });
  });

  test("Given a slow price catalog When non-stream completion finishes Then the client response is not blocked", async () => {
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        return textStream([
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", text: "Hello" },
          { type: "text-end", id: "text-1" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
          },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const dbHome = tempHome();
    const app = createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });
    const originalFetch = globalThis.fetch;
    const catalogResponse = Promise.withResolvers<Response>();
    const catalogRequested = Promise.withResolvers<void>();
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://models.dev/api.json") {
        catalogRequested.resolve();
        return catalogResponse.promise;
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    try {
      let responseResolved = false;
      const responseTask = app
        .request("/v1/chat/completions", {
          body: JSON.stringify({ ...chatRequest, stream: false }),
          headers: { "content-type": "application/json" },
          method: "POST",
        })
        .then((response) => {
          responseResolved = true;
          return response;
        });

      await catalogRequested.promise;
      await Bun.sleep(0);
      expect(responseResolved).toBe(true);

      catalogResponse.resolve(Response.json({ openrouter: { models: {} } }));
      expect((await responseTask).status).toBe(200);
      expect(await recorded(dbHome)).toEqual({
        requests: [expect.objectContaining({ outcome: "success" })],
        usages: [expect.objectContaining({ inputTokens: 3, outputTokens: 2, totalTokens: 5 })],
      });
    } finally {
      catalogResponse.resolve(Response.json({ openrouter: { models: {} } }));
      globalThis.fetch = originalFetch;
    }
  });

  test("Given ai-sdk provider returns usage When completion finishes Then dashboard overview includes it", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        return textStream([
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", text: "Hel" },
          { type: "text-delta", id: "text-1", text: "lo" },
          { type: "text-end", id: "text-1" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: {
              inputTokenDetails: {
                noCacheTokens: undefined,
                cacheReadTokens: undefined,
                cacheWriteTokens: undefined,
              },
              inputTokens: 3,
              outputTokenDetails: {
                textTokens: undefined,
                reasoningTokens: undefined,
              },
              outputTokens: 2,
              totalTokens: 5,
            },
          },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({
      config: { providers: {} },
      dbHome: tempHome(),
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await response.text();

    // Then
    expect(await waitForUsageRow(app)).toEqual({
      range: "24h",
      metric: "tokens",
      groupBy: "provider",
      rangeStart: expect.any(String),
      rangeEnd: expect.any(String),
      bucketUnit: "hour",
      summary: expect.objectContaining({
        inputTokens: 3,
        outputTokens: 2,
        requestCount: 1,
        totalTokens: 5,
      }),
      series: [{ key: "mock-ai", kind: "dimension" }],
      buckets: expect.any(Array),
    });
  });

  test("Given ai-sdk provider When stream is omitted Then OpenAI JSON is returned", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        return textStream([
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", text: "Hello" },
          { type: "text-end", id: "text-1" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ model: chatRequest.model, messages: chatRequest.messages }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body.object).toBe("chat.completion");
    expect(body.choices[0].message.content).toBe("Hello");
  });

  test("Given first provider returns 429 When completion is posted Then next provider is used", async () => {
    const first = {
      id: "rate-limited",
      kind: "api",
      models: ["gpt-5-mini"],
      alias: { "gpt-5-mini": { model: "gpt-5-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      passthrough: async () => Response.json({ error: "rate limited" }, { status: 429 }),
    } satisfies ApiProviderInstance;
    const second = {
      id: "ok",
      kind: "ai-sdk",
      models: ["gpt-5-mini"],
      alias: { "gpt-5-mini": { model: "gpt-5-mini", preserve: false } },
      invoke: () =>
        textStream([
          { type: "text-start", id: "fallback" },
          { type: "text-delta", id: "fallback", text: "fallback ok" },
          { type: "text-end", id: "fallback" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]),
    } satisfies AiSdkProviderInstance;
    const dbHome = tempHome();
    const app = createServer({ config: { providers: {} }, dbHome, providerInstances: [first, second] });

    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }] }),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).toContain("fallback ok");
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          outcome: "success",
          attempts: [
            expect.objectContaining({ index: 0, providerId: "rate-limited", outcome: "failure" }),
            expect.objectContaining({ index: 1, providerId: "ok", outcome: "success" }),
          ],
        }),
      ],
      usages: [expect.objectContaining({ providerId: "ok", inputTokens: 1, outputTokens: 1 })],
    });
  });

  test("Given stream emits data then errors When completion streams Then request is failure", async () => {
    const dbHome = tempHome();
    const provider = {
      id: "broken-after-data",
      kind: "ai-sdk",
      models: ["gpt-5-mini"],
      alias: { "gpt-5-mini": { model: "gpt-5-mini", preserve: false } },
      invoke: () =>
        new ReadableStream<TextStreamPart<ToolSet>>({
          start(controller) {
            controller.enqueue({ type: "text-delta", id: "text-1", text: "partial" });
            controller.error(new Error("stream broke"));
          },
        }),
    } satisfies AiSdkProviderInstance;
    const app = createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });

    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }], stream: true }),
    });
    await response.text();

    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({ outcome: "failure", attempts: [expect.objectContaining({ outcome: "failure" })] }),
      ],
      usages: [],
    });
  });

  test("Given first native provider throws When completion is posted Then next provider is used", async () => {
    const first = {
      id: "offline",
      kind: "api",
      models: ["gpt-5-mini"],
      alias: { "gpt-5-mini": { model: "gpt-5-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      passthrough: async () => {
        throw new Error("connection refused");
      },
    } satisfies ApiProviderInstance;
    const second = {
      id: "ok",
      kind: "api",
      models: ["gpt-5-mini"],
      alias: { "gpt-5-mini": { model: "gpt-5-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      passthrough: async () => Response.json({ fallback: true }),
    } satisfies ApiProviderInstance;
    const app = createServer({ config: { providers: {} }, providerInstances: [first, second] });

    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fallback: true });
  });

  test("Given first AI SDK stream fails before its first event When completion streams Then next provider is used", async () => {
    const first = {
      id: "broken-stream",
      kind: "ai-sdk",
      models: ["gpt-5-mini"],
      alias: { "gpt-5-mini": { model: "gpt-5-mini", preserve: false } },
      invoke: () => errorStream(new Error("upstream exploded")),
    } satisfies AiSdkProviderInstance;
    const second = {
      id: "ok",
      kind: "ai-sdk",
      models: ["gpt-5-mini"],
      alias: { "gpt-5-mini": { model: "gpt-5-mini", preserve: false } },
      invoke: () =>
        textStream([
          { type: "text-start", id: "fallback" },
          { type: "text-delta", id: "fallback", text: "fallback ok" },
          { type: "text-end", id: "fallback" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]),
    } satisfies AiSdkProviderInstance;
    const app = createServer({ config: { providers: {} }, providerInstances: [first, second] });

    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }], stream: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("fallback ok");
  });

  test("Given first provider returns 400 When completion is posted Then no fallback occurs", async () => {
    let secondCalled = false;
    const first = {
      id: "bad-request",
      kind: "api",
      models: ["gpt-5-mini"],
      alias: { "gpt-5-mini": { model: "gpt-5-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      passthrough: async () => Response.json({ error: "bad request" }, { status: 400 }),
    } satisfies ApiProviderInstance;
    const second = {
      id: "ok",
      kind: "ai-sdk",
      models: ["gpt-5-mini"],
      alias: { "gpt-5-mini": { model: "gpt-5-mini", preserve: false } },
      invoke: () => {
        secondCalled = true;
        return textStream([
          { type: "text-start", id: "fallback" },
          { type: "text-delta", id: "fallback", text: "fallback ok" },
          { type: "text-end", id: "fallback" },
          {
            type: "finish",
            finishReason: "stop",
            rawFinishReason: "stop",
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({ config: { providers: {} }, providerInstances: [first, second] });

    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5-mini", messages: [{ role: "user", content: "hi" }] }),
    });

    expect(response.status).toBe(400);
    expect(secondCalled).toBe(false);
  });

  test("Given ai-sdk provider returns upstream status error When non-stream completion is posted Then OpenAI error hides provider id", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        return errorStream(new UpstreamStatusError("upstream denied"));
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const text = await response.text();
    const body = JSON.parse(text);

    // Then
    expect(response.status).toBe(401);
    expect(body).toEqual({
      error: {
        code: "upstream_error",
        message: "upstream denied",
        type: "invalid_request_error",
      },
    });
    expect(text).not.toContain("mock-ai");
  });

  test("Given ai-sdk provider returns abort error When non-stream completion is posted Then OpenAI error uses 499", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        return errorStream(new AbortStreamError("client closed request"));
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(499);
    expect(body).toEqual({
      error: {
        code: "aborted",
        message: "client closed request",
        type: "invalid_request_error",
      },
    });
  });

  test.each([
    false,
    true,
  ])("Given an aborted inbound signal and wrapped AbortError When stream is %s Then request is cancelled", async (stream) => {
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke: () =>
        errorStream(new AiSdkProviderError("mock-ai", new AbortStreamError("client closed request")), [
          { type: "text-delta", id: "text-1", text: "partial" },
        ]),
    } satisfies AiSdkProviderInstance;
    const dbHome = tempHome();
    const app = createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });
    const abort = new AbortController();
    abort.abort();

    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, stream }),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: abort.signal,
    });
    await response.text().catch(() => undefined);

    expect(response.status).toBe(stream ? 200 : 499);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          outcome: "cancelled",
          attempts: [expect.objectContaining({ outcome: "cancelled" })],
        }),
      ],
      usages: [],
    });
  });

  test("Given ai-sdk provider package is missing When non-stream completion is posted Then OpenAI error is actionable 503", async () => {
    // Given
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "missing-ai",
        packageName: "@vendor/missing-provider",
        models: ["gpt-4o-mini"],
        alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      },
      {
        async loadProvider() {
          return null;
        },
      },
    );
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(503);
    expect(body).toEqual({
      error: {
        code: "provider_not_installed",
        message:
          'missing-ai: ai-sdk provider package "@vendor/missing-provider" is not installed; run aio-proxy provider install @vendor/missing-provider',
        type: "invalid_request_error",
      },
    });
  });

  test("Given ai-sdk provider package is missing When stream completion is posted Then OpenAI error is actionable 503", async () => {
    // Given
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "missing-ai",
        packageName: "@vendor/missing-provider",
        models: ["gpt-4o-mini"],
        alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      },
      {
        async loadProvider() {
          return null;
        },
      },
    );
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify(chatRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).not.toContain("text/event-stream");
    const body = await response.json();
    expect(body).toEqual({
      error: {
        code: "provider_not_installed",
        message:
          'missing-ai: ai-sdk provider package "@vendor/missing-provider" is not installed; run aio-proxy provider install @vendor/missing-provider',
        type: "invalid_request_error",
      },
    });
  });

  test("Given ai-sdk provider returns generic error When non-stream completion is posted Then OpenAI error hides provider id", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        throw new Error("model exploded");
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const text = await response.text();
    const body = JSON.parse(text);

    // Then
    expect(response.status).toBe(500);
    expect(body).toEqual({
      error: {
        code: "internal_error",
        message: "model exploded",
        type: "invalid_request_error",
      },
    });
    expect(text).not.toContain("mock-ai");
  });

  test("Given no matching alias When completion is posted Then returns 404 OpenAI error envelope", async () => {
    // Given
    let invoked = false;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        invoked = true;
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: JSON.stringify({ ...chatRequest, model: "missing-model" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: {
        code: "model_not_found",
        message: "Model not found: missing-model",
        type: "invalid_request_error",
      },
    });
    expect(invoked).toBe(false);
  });

  test("Given oversized content-length When completion is posted Then rejects before provider invocation", async () => {
    // Given
    let invoked = false;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gpt-4o-mini"],
      alias: { "gpt-4o-mini": { model: "gpt-4o-mini", preserve: false } },
      invoke() {
        invoked = true;
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/chat/completions", {
      body: "{}",
      headers: {
        "content-length": String(8 * 1_024 * 1_024 + 1),
        "content-type": "application/json",
      },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(413);
    expect(body).toEqual({
      error: {
        code: "request_too_large",
        message: "Request body too large",
        type: "invalid_request_error",
      },
    });
    expect(invoked).toBe(false);
  });
});
