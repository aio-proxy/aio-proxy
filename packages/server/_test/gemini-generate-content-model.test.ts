import type { ModelMessage, ToolSet } from "ai";

import { type AiSdkProviderInstance, REQUEST_BODY_LIMITS } from "@aio-proxy/core";
import { asSchema } from "ai";
import { describe, expect, test } from "bun:test";

import {
  aiSdkProvider,
  appWith,
  generateRequest,
  jsonHeaders,
  type ProviderSeenSettings,
  postGenerate,
  textStream,
} from "./gemini-generate-content.test-support";

describe("POST /v1beta/models/:model::generateContent", () => {
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
    const app = await appWith(provider);

    // When
    const response = await postGenerate(app);
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(messagesSeen).toEqual([{ role: "user", content: [{ type: "text", text: "Hello proxy" }] }]);
    expect(modelSeen).toBe("gemini-2.5-flash");
    expect(settingsSeen).toEqual({});
    expect(body).toMatchObject({
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
      modelVersion: "gemini-2.5-flash",
    });
    expect(body.responseId).toStartWith("resp_");
  });

  test("Given an alias variant and ai-sdk provider When generateContent is posted Then reasoning selects and configures it", async () => {
    // Given
    let modelSeen: string | undefined;
    let settingsSeen: ProviderSeenSettings | undefined;
    const provider = {
      id: "mock-ai",
      kind: "ai-sdk",
      models: ["gemini-default", "gemini-high"],
      alias: {
        "gemini-alias": {
          model: "gemini-default",
          preserve: false,
          variants: { high: { model: "gemini-high", preserve: false } },
        },
      },
      invoke(request) {
        modelSeen = request.modelId;
        settingsSeen = request.settings;
        return textStream([]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await appWith(provider);

    // When
    const response = await postGenerate(
      app,
      {
        ...generateRequest,
        generationConfig: { thinkingConfig: { thinkingLevel: "HIGH" } },
      },
      "gemini-alias",
    );
    await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(modelSeen).toBe("gemini-high");
    expect(settingsSeen).toEqual({ reasoning: "high" });
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
    const app = await appWith(provider);

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
    const app = await appWith(provider);

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

  test("Given forged oversized Content-Length When generateContent is posted Then returns 413 before provider invocation", async () => {
    // Given
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = await appWith(provider);

    // When
    const response = await app.request("/v1beta/models/gemini-2.5-flash:generateContent", {
      body: JSON.stringify(generateRequest),
      headers: {
        ...jsonHeaders,
        "content-length": String(REQUEST_BODY_LIMITS.encoded + 1),
      },
      method: "POST",
    });

    // Then
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: {
        code: 413,
        message: "Request body too large",
        status: "RESOURCE_EXHAUSTED",
      },
    });
    expect(invoked).toBe(false);
  });

  test("Given oversized inlineData When generateContent is posted Then returns 413 Gemini error envelope", async () => {
    // Given
    let invoked = false;
    const provider = aiSdkProvider(() => {
      invoked = true;
      return textStream([]);
    });
    const app = await appWith(provider);
    const data = "A".repeat(27_962_028);

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

describe("POST /v1beta/models/:model::streamGenerateContent", () => {});
