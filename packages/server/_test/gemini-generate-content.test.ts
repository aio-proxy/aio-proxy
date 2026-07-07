import { describe, expect, test } from "bun:test";
import type { AiSdkProviderInstance, ApiProviderInstance } from "@aio-proxy/core";
import { createServer } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";
import type { CallSettings, JSONValue, ModelMessage, TextStreamPart, ToolSet } from "ai";
import { asSchema } from "ai";

const generateRequest = {
  contents: [{ role: "user", parts: [{ text: "Hello proxy" }] }],
};
const jsonHeaders = { "content-type": "application/json" } as const;
type ProviderSeenSettings = CallSettings & {
  readonly providerOptions?: {
    readonly google: {
      readonly safetySettings: JSONValue;
    };
  };
};

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

function appWith(provider?: ApiProviderInstance | AiSdkProviderInstance): ReturnType<typeof createServer> {
  return createServer({
    config: { providers: {} },
    providerInstances: provider === undefined ? [] : [provider],
  });
}

function googleNativeProvider(passthrough: ApiProviderInstance["passthrough"]): ApiProviderInstance {
  return {
    id: "google",
    kind: "api",
    models: ["gemini-2.5-flash"],
    alias: { "gemini-2.5-flash": { model: "gemini-2.5-flash", preserve: false } },
    protocol: ProviderProtocol.Gemini,
    passthrough,
  };
}

function aiSdkProvider(invoke: AiSdkProviderInstance["invoke"]): AiSdkProviderInstance {
  return {
    id: "mock-ai",
    kind: "ai-sdk",
    models: ["gemini-2.5-flash"],
    alias: { "gemini-2.5-flash": { model: "gemini-2.5-flash", preserve: false } },
    invoke,
  };
}

function postGenerate(
  app: ReturnType<typeof createServer>,
  body: string | object = generateRequest,
  model = "gemini-2.5-flash",
): Promise<Response> {
  return app.request(`/v1beta/models/${model}:generateContent`, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: jsonHeaders,
    method: "POST",
  });
}

function postStream(app: ReturnType<typeof createServer>): Promise<Response> {
  return app.request("/v1beta/models/gemini-2.5-flash:streamGenerateContent", {
    body: JSON.stringify(generateRequest),
    headers: jsonHeaders,
    method: "POST",
  });
}

describe("POST /v1beta/models/:model::generateContent", () => {
  test("Given gemini api provider When generateContent is posted Then passthrough receives original bytes", async () => {
    // Given
    const requestBody = JSON.stringify(generateRequest);
    let bodySeen = "";
    const provider = googleNativeProvider(async (req) => {
      bodySeen = await req.text();
      return new Response("provider-bytes", {
        headers: { "x-provider": "google" },
        status: 202,
      });
    });
    const app = appWith(provider);

    // When
    const response = await postGenerate(app, requestBody);

    // Then
    expect(response.status).toBe(202);
    expect(response.headers.get("x-provider")).toBe("google");
    expect(await response.text()).toBe("provider-bytes");
    expect(bodySeen).toBe(requestBody);
  });

  test("Given gemini oversized inlineData When generateContent is posted Then returns 413 without passthrough", async () => {
    // Given
    let invoked = false;
    const provider = googleNativeProvider(async () => {
      invoked = true;
      return new Response("provider-invoked", { status: 202 });
    });
    const app = appWith(provider);
    const data = `${"A".repeat(27_962_028)}====`;

    // When
    const response = await postGenerate(app, {
      contents: [
        {
          parts: [{ inlineData: { mimeType: "image/png", data } }],
        },
      ],
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(413);
    expect(body).toEqual({
      error: {
        code: 413,
        message: "Gemini inlineData at contents.0.parts.0.inlineData.data is 20971521 bytes; limit is 20971520",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    expect(invoked).toBe(false);
  });

  test("Given ai-sdk provider When generateContent is posted Then Gemini JSON is returned", async () => {
    // Given
    let messagesSeen: readonly ModelMessage[] | undefined;
    let modelSeen: string | undefined;
    let settingsSeen: ProviderSeenSettings | undefined;
    const provider = aiSdkProvider((request) => {
      messagesSeen = request.messages;
      modelSeen = request.modelId;
      settingsSeen = request.settings;
      return textStream([
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
    });
    const app = appWith(provider);

    // When
    const response = await postGenerate(app);
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(messagesSeen).toEqual([{ role: "user", content: [{ type: "text", text: "Hello proxy" }] }]);
    expect(modelSeen).toBe("gemini-2.5-flash");
    expect(settingsSeen).toEqual({});
    expect(body).toEqual({
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
    });
  });

  test("Given tools and safetySettings When generateContent is posted Then provider receives them", async () => {
    // Given
    const parameters = {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    };
    const safetySettings = [
      {
        category: "HARM_CATEGORY_DANGEROUS_CONTENT",
        threshold: "BLOCK_ONLY_HIGH",
      },
    ];
    let settingsSeen: ProviderSeenSettings | undefined;
    let toolsSeen: ToolSet | undefined;
    const provider = aiSdkProvider((request) => {
      settingsSeen = request.settings;
      toolsSeen = request.tools;
      return textStream([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", text: "ok" },
        { type: "text-end", id: "text-1" },
      ]);
    });
    const app = appWith(provider);

    // When
    const response = await postGenerate(app, {
      contents: [{ role: "user", parts: [{ text: "Weather?" }] }],
      generationConfig: { temperature: 0.2 },
      safetySettings,
      tools: [
        {
          functionDeclarations: [
            {
              name: "get_weather",
              description: "Returns weather for a city.",
              parameters,
            },
          ],
        },
      ],
    });

    // Then
    const weatherTool = toolsSeen?.get_weather;
    if (weatherTool === undefined) {
      throw new Error("Expected provider to receive get_weather tool");
    }

    expect(response.status).toBe(200);
    expect(settingsSeen).toEqual({
      temperature: 0.2,
      providerOptions: { google: { safetySettings } },
    });
    expect(weatherTool.type).toBe("function");
    expect(weatherTool.description).toBe("Returns weather for a city.");
    expect(await asSchema(weatherTool.inputSchema).jsonSchema).toEqual(parameters);
  });

  test("Given no matching alias When generateContent is posted Then returns 404 Gemini error envelope", async () => {
    // Given
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = appWith(provider);

    // When
    const response = await postGenerate(app, generateRequest, "missing-model");
    const body = await response.json();

    // Then
    expect(response.status).toBe(404);
    expect(body).toEqual({
      error: {
        code: 404,
        message: "Model not found: missing-model",
        status: "NOT_FOUND",
      },
    });
    expect(invoked).toBe(false);
  });

  test("Given 9MiB inlineData with large Content-Length When generateContent is posted Then provider receives it", async () => {
    // Given
    let messagesSeen: readonly ModelMessage[] | undefined;
    const provider = aiSdkProvider((request) => {
      messagesSeen = request.messages;
      return textStream([
        { type: "text-start", id: "text-1" },
        { type: "text-delta", id: "text-1", text: "accepted" },
        { type: "text-end", id: "text-1" },
      ]);
    });
    const app = appWith(provider);
    const data = "A".repeat(12_582_912);
    const body = JSON.stringify({
      contents: [
        {
          parts: [{ inlineData: { mimeType: "image/png", data } }],
        },
      ],
    });

    // When
    const response = await app.request("/v1beta/models/gemini-2.5-flash:generateContent", {
      body,
      headers: {
        ...jsonHeaders,
        "content-length": String(body.length),
      },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      candidates: [
        {
          content: { role: "model", parts: [{ text: "accepted" }] },
          finishReason: "OTHER",
        },
      ],
    });
    expect(messagesSeen).toEqual([
      {
        role: "user",
        content: [
          {
            type: "file",
            mediaType: "image/png",
            data: { type: "data", data },
          },
        ],
      },
    ]);
  });

  test("Given oversized inlineData When generateContent is posted Then returns 413 Gemini error envelope", async () => {
    // Given
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = appWith(provider);
    const data = `${"A".repeat(27_962_028)}====`;

    // When
    const response = await postGenerate(app, {
      contents: [
        {
          parts: [{ inlineData: { mimeType: "image/png", data } }],
        },
      ],
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(413);
    expect(body).toEqual({
      error: {
        code: 413,
        message: "Gemini inlineData at contents.0.parts.0.inlineData.data is 20971521 bytes; limit is 20971520",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    expect(invoked).toBe(false);
  });
});

describe("POST /v1beta/models/:model::streamGenerateContent", () => {
  test("Given gemini api provider When streamGenerateContent is posted Then passthrough preserves stream bytes", async () => {
    // Given
    const provider = googleNativeProvider(async () => {
      return new Response('data: {"upstream":true}\n\n', {
        headers: { "content-type": "text/event-stream" },
        status: 200,
      });
    });
    const app = appWith(provider);

    // When
    const response = await postStream(app);

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(await response.text()).toBe('data: {"upstream":true}\n\n');
  });

  test("Given gemini oversized inlineData When streamGenerateContent is posted Then returns 413 without passthrough", async () => {
    // Given
    let invoked = false;
    const provider = googleNativeProvider(async () => {
      invoked = true;
      return new Response('data: {"upstream":true}\n\n', { status: 200 });
    });
    const app = appWith(provider);
    const data = `${"A".repeat(27_962_028)}====`;

    // When
    const response = await app.request("/v1beta/models/gemini-2.5-flash:streamGenerateContent", {
      body: JSON.stringify({
        contents: [
          {
            parts: [{ inlineData: { mimeType: "image/png", data } }],
          },
        ],
      }),
      headers: jsonHeaders,
      method: "POST",
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(413);
    expect(body).toEqual({
      error: {
        code: 413,
        message: "Gemini inlineData at contents.0.parts.0.inlineData.data is 20971521 bytes; limit is 20971520",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    expect(invoked).toBe(false);
  });

  test("Given ai-sdk provider When streamGenerateContent is posted Then exact Gemini SSE frames are returned", async () => {
    // Given
    const provider = aiSdkProvider(() => {
      return textStream([
        { type: "text-delta", id: "text-1", text: "Hel" },
        { type: "text-delta", id: "text-1", text: "lo" },
        {
          type: "finish",
          finishReason: "stop",
          rawFinishReason: "STOP",
          totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
        },
      ]);
    });
    const app = appWith(provider);

    // When
    const response = await postStream(app);
    const text = await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toBe(
      'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hel"}]}}]}\n\n' +
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"lo"}]}}]}\n\n' +
        'data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":2,"totalTokenCount":5}}\n\n',
    );
  });
});

describe("Gemini generateContent route matching", () => {
  test("Given missing method suffix When model path is posted Then Hono returns 404", async () => {
    // Given
    const app = appWith();

    // When
    const response = await app.request("/v1beta/models/gemini-2.5-flash", {
      body: JSON.stringify(generateRequest),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("404 Not Found");
  });
});
