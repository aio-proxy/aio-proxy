import { describe, expect, test } from "bun:test";
import type { LogicalRequestContext } from "@aio-proxy/plugin-sdk";
import { createAntigravityLanguageModel } from "./google-model";
import { createAntigravityProviderV4, createGoogleAntigravityRuntime } from "./provider";
import type { CcaTransport } from "./transport";

describe("Google Antigravity ProviderV4", () => {
  test("exposes literal v4 language models for the routed wire ID", () => {
    const provider = createAntigravityProviderV4(fixtureRuntime(captureTransport({}).transport));

    const model = provider.languageModel("gemini-3-flash-agent");

    expect(provider.specificationVersion).toBe("v4");
    expect(model.specificationVersion).toBe("v4");
    expect(model.modelId).toBe("gemini-3-flash-agent");
    expect(() => provider.embeddingModel("embedding")).toThrow("does not support embedding");
    expect(() => provider.imageModel("image")).toThrow("does not support image generation");
  });

  test("uses the Google codec while stripping private options and preserving images and Google options", async () => {
    const response = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "hello" }, { functionCall: { id: "call-1", name: "weather", args: { city: "Shanghai" } } }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    };
    const captured = captureTransport(response);
    const model = createAntigravityLanguageModel("gemini-3-flash-agent", fixtureRuntime(captured.transport));

    const result = await model.doGenerate({
      prompt: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "file", mediaType: "image/png", data: { type: "data", data: new Uint8Array([1, 2, 3]) } },
          ],
        },
      ],
      providerOptions: {
        google: { responseModalities: ["TEXT"] },
        aioProxy: { logicalRequest: logicalContext(), thinking: { mode: "adaptive", effort: "high" } },
      },
    } as never);

    expect(result.content).toContainEqual({ type: "text", text: "hello", providerMetadata: undefined });
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "tool-call", toolCallId: "call-1", toolName: "weather" }),
    );
    expect(result.finishReason).toEqual({ unified: "tool-calls", raw: "STOP" });
    expect(result.usage).toMatchObject({ inputTokens: { total: 3 }, outputTokens: { total: 2, text: 2 } });
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0]).toMatchObject({
      context: logicalContext(),
      modelId: "gemini-3-flash-agent",
      requestType: "agent",
      stream: false,
      body: {
        generationConfig: {
          responseModalities: ["TEXT"],
          thinkingConfig: { thinkingBudget: 10000, includeThoughts: true },
        },
        contents: [
          {
            role: "user",
            parts: [{ text: "what is this?" }, { inlineData: { mimeType: "image/png", data: "AQID" } }],
          },
        ],
      },
    });
    expect(JSON.stringify(captured.calls[0]?.body)).not.toContain("aioProxy");
  });

  test("decodes CCA SSE through the Google stream codec", async () => {
    const captured = captureStreamTransport([
      { candidates: [{ content: { role: "model", parts: [{ text: "hello" }] } }] },
      {
        candidates: [
          {
            content: { role: "model", parts: [{ functionCall: { id: "call-2", name: "weather", args: {} } }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
      },
    ]);
    const model = createAntigravityLanguageModel("gemini-3-flash-agent", fixtureRuntime(captured.transport));

    const result = await model.doStream(callOptions());
    const parts = await collect(result.stream);

    expect(parts).toContainEqual(expect.objectContaining({ type: "text-delta", delta: "hello" }));
    expect(parts).toContainEqual(
      expect.objectContaining({ type: "tool-call", toolCallId: "call-2", toolName: "weather" }),
    );
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: "finish",
        finishReason: { unified: "tool-calls", raw: "STOP" },
        usage: expect.objectContaining({ inputTokens: expect.objectContaining({ total: 4 }) }),
      }),
    );
    expect(captured.calls[0]).toMatchObject({ modelId: "gemini-3-flash-agent", stream: true });
  });

  test("builds the final runtime with ProviderV4, Gemini raw, and token-count capabilities", async () => {
    let envelope: Record<string, unknown> | undefined;
    const runtime = await createGoogleAntigravityRuntime(runtimeContext(), {
      fetch: async (_input, init) => {
        envelope = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ response: textResponse("runtime") });
      },
    });

    const result = await runtime.provider.languageModel("claude-sonnet-4-6").doGenerate({
      ...callOptions(),
      tools: [
        {
          type: "function",
          name: "weather",
          description: "Forecast",
          inputSchema: {
            type: "object",
            properties: { days: { type: "number", enum: [1, 3], minLength: 1 } },
          },
        },
      ],
    } as never);

    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "runtime" }));
    expect(envelope).toMatchObject({
      model: "claude-sonnet-4-6",
      request: {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
        tools: [
          {
            functionDeclarations: [
              {
                name: "weather",
                parameters: {
                  type: "object",
                  properties: {
                    days: expect.objectContaining({ type: "string", enum: ["1", "3"] }),
                  },
                },
              },
            ],
          },
        ],
        toolConfig: { functionCallingConfig: { mode: "VALIDATED" } },
      },
    });
    expect(runtime.raw?.({ protocol: "gemini", modelId: "gemini-3-flash-agent" })).toBeDefined();
    expect(runtime.tokenCount).toBeDefined();
  });
});

function fixtureRuntime(transport: CcaTransport) {
  return { call: (context: LogicalRequestContext) => ({ context, transport }) };
}

function captureTransport(response: unknown) {
  const calls: Parameters<CcaTransport["execute"]>[0][] = [];
  return {
    calls,
    transport: {
      async execute(input) {
        calls.push(input);
        return Response.json({ response });
      },
    } satisfies CcaTransport,
  };
}

function captureStreamTransport(events: readonly unknown[]) {
  const calls: Parameters<CcaTransport["execute"]>[0][] = [];
  return {
    calls,
    transport: {
      async execute(input) {
        calls.push(input);
        return ccaSse(
          new ReadableStream({
            start(controller) {
              const encoder = new TextEncoder();
              for (const event of events) {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: event })}\n\n`));
              }
              controller.close();
            },
          }),
        );
      },
    } satisfies CcaTransport,
  };
}

function ccaSse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

function textResponse(text: string) {
  return { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }] };
}

function callOptions() {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    providerOptions: { aioProxy: { logicalRequest: logicalContext() } },
  } as never;
}

function logicalContext(): LogicalRequestContext {
  return {
    requestId: "00000000-0000-4000-8000-000000000001",
    session: { key: "sha256:abc", source: "transcript" },
  };
}

function runtimeContext() {
  const credential = {
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: 4_000_000_000_000,
    email: "person@example.com",
    projectId: "project",
  };
  return {
    credentials: {
      read: async () => ({ value: credential, revision: 1 }),
      refresh: async () => ({ status: "superseded" as const, snapshot: { value: credential, revision: 1 } }),
    },
    options: {},
    catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
  };
}

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}
