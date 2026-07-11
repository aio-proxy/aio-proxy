import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AiSdkProviderInstance, ApiProviderInstance } from "@aio-proxy/core";
import { createAiSdkProvider } from "@aio-proxy/core";
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

describe("POST /v1/messages", () => {
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
    const app = createServer({
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
    const app = createServer({ config: { providers: {} }, dbHome, providerInstances: [first, second] });

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
    const app = createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });

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
    const app = createServer({
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
    const app = createServer({
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
    const app = createServer({
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
    const app = createServer({
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
});
