import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiSdkProviderError, type AiSdkProviderInstance, type ApiProviderInstance } from "@aio-proxy/core";
import { openDb, requestLog, usage } from "@aio-proxy/core/db";
import { createServer } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";
import type { CallSettings, ModelMessage, TextStreamPart, ToolSet } from "ai";

const responsesRequest = {
  model: "gpt-4.1-mini",
  input: "Say pong.",
  stream: true,
};
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-responses-usage-"));
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

function aiSdkProvider(invoke: AiSdkProviderInstance["invoke"]): AiSdkProviderInstance {
  return {
    id: "mock-ai",
    kind: "ai-sdk",
    models: ["gpt-4.1-mini"],
    alias: { "gpt-4.1-mini": { model: "gpt-4.1-mini", preserve: false } },
    invoke,
  };
}

class AbortStreamError extends Error {
  override readonly name = "AbortError";
}

function unsupportedEnvelope(feature: string) {
  return {
    error: {
      code: "unsupported_feature",
      message: `OpenAI Responses feature is not supported: ${feature}`,
      type: "unsupported_feature",
    },
  };
}

const unsupportedBeforeProviderInvocationCases = [
  {
    body: { ...responsesRequest, previous_response_id: "resp-old" },
    feature: "previous_response_id",
    name: "previous_response_id",
  },
  {
    body: { ...responsesRequest, store: true },
    feature: "store",
    name: "store true",
  },
  {
    body: { ...responsesRequest, background: true },
    feature: "background",
    name: "background true",
  },
] as const;

describe("OpenAI Responses routes", () => {
  test("Given openai-response api provider When POST is valid Then raw request and response bytes pass through", async () => {
    // Given
    const rawRequest = '{"model":"gpt-4.1-mini","input":"Say pong.","stream":false}';
    let bodySeen = "";
    const provider = {
      id: "openai",
      kind: "api",
      models: ["gpt-4.1-mini"],
      alias: { "gpt-4.1-mini": { model: "gpt-4.1-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAIResponse,
      async passthrough(req) {
        bodySeen = await req.text();
        return new Response('{"upstream":true}', {
          headers: { "content-type": "application/json", "x-upstream": "1" },
          status: 203,
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
    const response = await app.request("/v1/responses", {
      body: rawRequest,
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(203);
    expect(response.headers.get("x-upstream")).toBe("1");
    expect(await response.text()).toBe('{"upstream":true}');
    expect(bodySeen).toBe(rawRequest);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          inboundProtocol: ProviderProtocol.OpenAIResponse,
          requestedModelId: "gpt-4.1-mini",
          finalProviderId: "openai",
          finalModelId: "gpt-4.1-mini",
          outcome: "success",
          attempts: [expect.objectContaining({ index: 0, providerId: "openai", outcome: "success" })],
        }),
      ],
      usages: [],
    });
  });

  test("Given first native provider throws When POST is valid Then next provider is used", async () => {
    const first = {
      id: "offline",
      kind: "api",
      models: ["gpt-4.1-mini"],
      alias: { "gpt-4.1-mini": { model: "gpt-4.1-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAIResponse,
      passthrough: async () => {
        throw new Error("connection refused");
      },
    } satisfies ApiProviderInstance;
    const second = {
      id: "ok",
      kind: "api",
      models: ["gpt-4.1-mini"],
      alias: { "gpt-4.1-mini": { model: "gpt-4.1-mini", preserve: false } },
      protocol: ProviderProtocol.OpenAIResponse,
      passthrough: async () => Response.json({ fallback: true }),
    } satisfies ApiProviderInstance;
    const dbHome = tempHome();
    const app = createServer({ config: { providers: {} }, dbHome, providerInstances: [first, second] });

    const response = await app.request("/v1/responses", {
      body: JSON.stringify({ ...responsesRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(200);
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

  test("Given stream emits data then errors When Responses streams Then request is failure", async () => {
    const dbHome = tempHome();
    const provider = aiSdkProvider(
      () =>
        new ReadableStream<TextStreamPart<ToolSet>>({
          start(controller) {
            controller.enqueue({ type: "text-delta", id: "text-1", text: "partial" });
            controller.error(new Error("stream broke"));
          },
        }),
    );
    const app = createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });

    const response = await app.request("/v1/responses", {
      body: JSON.stringify(responsesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await response.text();

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
  ])("Given an aborted inbound signal and wrapped AbortError When Responses stream is %s Then request is cancelled", async (stream) => {
    const dbHome = tempHome();
    const provider = aiSdkProvider(() => {
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
    });
    const app = createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });
    const abort = new AbortController();
    abort.abort();

    const response = await app.request("/v1/responses", {
      body: JSON.stringify({ ...responsesRequest, stream }),
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

  test("Given an alias variant and native provider When POST is valid Then passthrough receives the variant model", async () => {
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
      protocol: ProviderProtocol.OpenAIResponse,
      async passthrough(req) {
        bodySeen = await req.json();
        return Response.json({ ok: true });
      },
    } satisfies ApiProviderInstance;
    const app = createServer({ config: { providers: {} }, providerInstances: [provider] });

    // When
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({ ...responsesRequest, model: "mini", reasoning: { effort: "high" } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(200);
    expect(bodySeen).toEqual({ ...responsesRequest, model: "gpt-high", reasoning: { effort: "high" } });
  });

  test("Given ai-sdk provider When POST streams text Then Responses SSE events are returned", async () => {
    // Given
    let messagesSeen: readonly ModelMessage[] | undefined;
    let modelSeen: string | undefined;
    let settingsSeen: CallSettings | undefined;
    let toolsSeen: ToolSet | undefined;
    const provider = aiSdkProvider((request) => {
      messagesSeen = request.messages;
      modelSeen = request.modelId;
      settingsSeen = request.settings;
      toolsSeen = request.tools;
      return textStream([
        { type: "text-delta", id: "text-1", text: "pong" },
        {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: "stop",
          totalUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        },
      ]);
    });
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        ...responsesRequest,
        tools: [{ type: "function", name: "lookup" }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const text = await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(messagesSeen).toEqual([{ role: "user", content: "Say pong." }]);
    expect(modelSeen).toBe("gpt-4.1-mini");
    expect(settingsSeen).toEqual({ stream: true });
    expect(Object.keys(toolsSeen ?? {})).toEqual(["lookup"]);
    expect(text).toContain("event: response.created");
    expect(text).toContain("event: response.output_item.added");
    expect(text).toContain("event: response.output_text.delta");
    expect(text).toContain('"delta":"pong"');
    expect(text).toContain("event: response.completed");
  });

  test("Given an alias variant and ai-sdk provider When POST is valid Then reasoning selects and configures it", async () => {
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
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({ ...responsesRequest, model: "mini", reasoning: { effort: "high" } }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(modelSeen).toBe("gpt-high");
    expect(settingsSeen).toEqual({ reasoning: "high", stream: true });
  });

  test("Given ai-sdk provider When POST streams reasoning Then reasoning summary deltas are returned", async () => {
    // Given
    const provider = aiSdkProvider(() =>
      textStream([
        { type: "reasoning-delta", id: "reason-1", text: "Thinking" },
        {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: "stop",
          totalUsage: {},
        },
      ]),
    );
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/responses", {
      body: JSON.stringify(responsesRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const text = await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(text).toContain("event: response.reasoning_summary_text.delta");
    expect(text).toContain('"delta":"Thinking"');
  });

  test("Given ai-sdk provider When POST is non-stream Then Responses JSON is returned", async () => {
    // Given
    const provider = aiSdkProvider(() =>
      textStream([
        { type: "text-delta", id: "text-1", text: "Pong" },
        {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: "stop",
          totalUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        },
      ]),
    );
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({ ...responsesRequest, stream: false }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body).toEqual({
      id: "resp-aio-proxy",
      object: "response",
      output: [
        {
          id: "msg-aio-proxy",
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Pong" }],
        },
      ],
      status: "completed",
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    });
  });

  for (const scenario of unsupportedBeforeProviderInvocationCases) {
    test(`Given ${scenario.name} When POST is requested Then unsupported feature is returned before provider invocation`, async () => {
      // Given
      let invoked = false;
      const provider = aiSdkProvider(() => {
        invoked = true;
        return textStream([]);
      });
      const app = createServer({
        config: { providers: {} },
        providerInstances: [provider],
      });

      // When
      const response = await app.request("/v1/responses", {
        body: JSON.stringify(scenario.body),
        headers: { "content-type": "application/json" },
        method: "POST",
      });

      // Then
      expect(response.status).toBe(501);
      expect(await response.json()).toEqual(unsupportedEnvelope(scenario.feature));
      expect(invoked).toBe(false);
    });
  }

  test("Given forbidden built-in tool When POST is requested Then unsupported feature is returned", async () => {
    // Given
    const app = createServer({ config: { providers: {} } });

    // When
    const response = await app.request("/v1/responses", {
      body: JSON.stringify({
        ...responsesRequest,
        tools: [{ type: "web_search_preview" }],
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual(unsupportedEnvelope("web_search_preview"));
  });

  test("Given stored response id When GET is requested Then retrieval is unsupported", async () => {
    // Given
    const app = createServer({ config: { providers: {} } });

    // When
    const response = await app.request("/v1/responses/resp-1");

    // Then
    expect(response.status).toBe(501);
    expect(await response.json()).toEqual(unsupportedEnvelope("response_retrieval"));
  });

  test("Given malformed JSON When POST is requested Then invalid request is returned before provider invocation", async () => {
    // Given
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request("/v1/responses", {
      body: "{",
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: {
        code: "invalid_request",
        message: "Invalid OpenAI Responses request",
        type: "invalid_request_error",
      },
    });
    expect(invoked).toBe(false);
  });
});
