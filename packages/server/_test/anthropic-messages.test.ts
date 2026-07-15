import { afterEach, describe, expect, test } from "bun:test";
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
import type { ModelMessage, TextStreamPart, ToolSet } from "ai";

const messagesRequest = {
  model: "claude-sonnet-4-5",
  max_tokens: 32,
  messages: [{ role: "user", content: "Hello proxy" }],
  stream: true,
};
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-anthropic-usage-"));
  homes.push(home);
  return home;
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

class AbortStreamError extends Error {
  override readonly name = "AbortError";
}

describe("POST /v1/messages", () => {
  test("Given a chunked body above 8 MiB When message is posted Then returns Anthropic 413 before provider invocation", async () => {
    let invoked = false;
    const provider = {
      id: "anthropic",
      kind: "api",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      protocol: ProviderProtocol.Anthropic,
      async passthrough() {
        invoked = true;
        return Response.json({ unexpected: true });
      },
    } satisfies ApiProviderInstance;
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });
    let chunks = 0;

    const response = await app.request(
      new Request("http://localhost/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            chunks += 1;
            controller.enqueue(new Uint8Array(1_024 * 1_024));
            if (chunks === 9) controller.close();
          },
        }),
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "Request body too large" },
    });
    expect(invoked).toBe(false);
  });

  test("Given anthropic api provider When message is posted Then passthrough receives original request", async () => {
    // Given
    let bodySeen: unknown;
    const provider = {
      id: "anthropic",
      kind: "api",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      protocol: ProviderProtocol.Anthropic,
      async passthrough(req) {
        bodySeen = await req.json();
        return new Response("provider-bytes", {
          headers: { "x-provider": "anthropic" },
          status: 202,
        });
      },
    } satisfies ApiProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({
      config: { providers: {} },
      dbHome,
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/messages", {
      body: JSON.stringify(messagesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(202);
    expect(response.headers.get("x-provider")).toBe("anthropic");
    expect(await response.text()).toBe("provider-bytes");
    expect(bodySeen).toEqual(messagesRequest);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          inboundProtocol: ProviderProtocol.Anthropic,
          requestedModelId: "claude-sonnet-4-5",
          finalProviderId: "anthropic",
          finalModelId: "claude-sonnet-4-5",
          outcome: "success",
          attempts: [expect.objectContaining({ index: 0, providerId: "anthropic", outcome: "success" })],
        }),
      ],
      usages: [],
    });
  });

  test("Given first native provider throws When message is posted Then next provider is used and attempts are ordered", async () => {
    const first = {
      id: "offline",
      kind: "api",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      protocol: ProviderProtocol.Anthropic,
      passthrough: async () => {
        throw new Error("connection refused");
      },
    } satisfies ApiProviderInstance;
    const second = {
      ...first,
      id: "ok",
      passthrough: async () => Response.json({ fallback: true }),
    } satisfies ApiProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [first, second] });

    const response = await app.request("/v1/messages", {
      body: JSON.stringify({ ...messagesRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(await response.json()).toEqual({ fallback: true });
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          attempts: [
            expect.objectContaining({ index: 0, providerId: "offline", outcome: "failure" }),
            expect.objectContaining({ index: 1, providerId: "ok", outcome: "success" }),
          ],
          outcome: "success",
        }),
      ],
      usages: [],
    });
  });

  test("Given first model provider fails before its first event When message is posted Then next provider is used", async () => {
    const first = {
      id: "broken-model",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      invoke: () => new ReadableStream({ start: (controller) => controller.error(new Error("preflight failed")) }),
    } satisfies AiSdkProviderInstance;
    const second = {
      ...first,
      id: "fallback-model",
      invoke: () =>
        textStream([
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", text: "fallback" },
          { type: "text-end", id: "text-1" },
        ]),
    } satisfies AiSdkProviderInstance;
    const app = await createServer({ config: { providers: {} }, providerInstances: [first, second] });

    const response = await app.request("/v1/messages", {
      body: JSON.stringify(messagesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"text":"fallback"');
  });

  test("Given tool-use and tool-result history When message is posted Then model receives complete tool parts", async () => {
    let messagesSeen: readonly ModelMessage[] | undefined;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      invoke(request) {
        messagesSeen = request.messages;
        return textStream([
          { type: "text-start", id: "text-1" },
          { type: "text-end", id: "text-1" },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });

    await app.request("/v1/messages", {
      body: JSON.stringify({
        ...messagesRequest,
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "toolu_weather", name: "weather", input: { city: "Paris" } }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_weather", content: "Sunny" }],
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(messagesSeen).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "toolu_weather", toolName: "weather", input: { city: "Paris" } }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_weather",
            toolName: "weather",
            output: { type: "text", value: "Sunny" },
          },
        ],
      },
    ]);
  });

  test("Given Anthropic tool definitions When routed through AI SDK Then model receives tools", async () => {
    let toolsSeen: ToolSet | undefined;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      invoke(request) {
        toolsSeen = request.tools;
        return textStream([{ type: "finish", finishReason: "stop", rawFinishReason: "stop", totalUsage: {} }]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });

    const response = await app.request("/v1/messages", {
      body: JSON.stringify({
        ...messagesRequest,
        stream: false,
        tools: [
          {
            name: "get_weather",
            description: "Returns weather for a city.",
            input_schema: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(Object.keys(toolsSeen ?? {})).toEqual(["get_weather"]);
    expect(toolsSeen?.get_weather?.description).toBe("Returns weather for a city.");
  });

  test("Given stream emits data then errors When message streams Then request is failure", async () => {
    const provider = {
      id: "broken-after-data",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      invoke: () =>
        new ReadableStream<TextStreamPart<ToolSet>>({
          start(controller) {
            controller.enqueue({ type: "text-delta", id: "text-1", text: "partial" });
            controller.error(new Error("stream broke"));
          },
        }),
    } satisfies AiSdkProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });

    const response = await app.request("/v1/messages", {
      body: JSON.stringify(messagesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await response.text().catch(() => undefined);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({ outcome: "failure", attempts: [expect.objectContaining({ outcome: "failure" })] }),
      ],
      usages: [],
    });
  });

  test.each([
    false,
    true,
  ])("Given an aborted inbound signal and wrapped AbortError When Anthropic stream is %s Then request is cancelled", async (stream) => {
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      invoke: () => {
        let sent = false;
        return new ReadableStream<TextStreamPart<ToolSet>>({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue({ type: "text-delta", id: "text-1", text: "partial" });
            } else {
              controller.error(new AiSdkProviderError("mock-ai", new AbortStreamError("client closed request")));
            }
          },
        });
      },
    } satisfies AiSdkProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });
    const abort = new AbortController();
    abort.abort();

    const response = await app.request("/v1/messages", {
      body: JSON.stringify({ ...messagesRequest, stream }),
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

  test.each([
    "provider rejected",
    null,
    { message: "provider rejected" },
  ])("Given final provider rejects %p When non-stream message is posted Then one failed request is recorded", async (reason) => {
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      invoke: () => new ReadableStream({ pull: (controller) => controller.error(reason) }),
    } satisfies AiSdkProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });

    const response = await app.request("/v1/messages", {
      body: JSON.stringify({ ...messagesRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(500);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          finalProviderId: "mock-ai",
          outcome: "failure",
          attempts: [expect.objectContaining({ index: 0, providerId: "mock-ai", outcome: "failure" })],
        }),
      ],
      usages: [],
    });
  });

  test("Given ai-sdk provider When stream message is posted Then provider is invoked and Anthropic SSE is returned", async () => {
    // Given
    let messagesSeen: readonly ModelMessage[] | undefined;
    let modelSeen: string | undefined;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
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
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/messages", {
      body: JSON.stringify(messagesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const text = await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(messagesSeen).toEqual([{ role: "user", content: "Hello proxy" }]);
    expect(modelSeen).toBe("claude-sonnet-4-5");
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: content_block_delta");
    expect(text).toContain('"text":"pong"');
    expect(text).toContain("event: message_stop");
  });

  test("Given no matching alias When message is posted Then returns 404 Anthropic error envelope", async () => {
    // Given
    let invoked = false;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      invoke() {
        invoked = true;
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/messages", {
      body: JSON.stringify({ ...messagesRequest, model: "missing-model" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(404);
    expect(body).toEqual({
      type: "error",
      error: {
        type: "not_found_error",
        message: "Model not found: missing-model",
      },
    });
    expect(invoked).toBe(false);
  });

  test("Given ai-sdk provider package is missing When stream message is posted Then Anthropic error is actionable 503 before SSE", async () => {
    // Given
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "missing-ai",
        packageName: "@vendor/missing-provider",
        models: ["claude-sonnet-4-5"],
        alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      },
      {
        async loadProvider() {
          return null;
        },
      },
    );
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/messages", {
      body: JSON.stringify(messagesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).not.toContain("text/event-stream");
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.message).toContain("run aio-proxy provider install @vendor/missing-provider");
  });
});

describe("POST /v1/messages/count_tokens", () => {
  test("Given message request When token count is posted Then returns input token count", async () => {
    // Given
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["claude-sonnet-4-5"],
      alias: { "claude-sonnet-4-5": { model: "claude-sonnet-4-5", preserve: false } },
      invoke() {
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/messages/count_tokens", {
      body: JSON.stringify(messagesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body).toEqual({ input_tokens: 2 });
    expect(typeof body.input_tokens).toBe("number");
  });

  test("Given oversized Content-Length When token count is posted Then rejects before parsing", async () => {
    const app = await createServer({ config: { providers: {} } });

    const response = await app.request("/v1/messages/count_tokens", {
      body: JSON.stringify(messagesRequest),
      headers: {
        "content-length": String(8 * 1_024 * 1_024 + 1),
        "content-type": "application/json",
      },
      method: "POST",
    });

    expect(response.status).toBe(413);
  });
});
