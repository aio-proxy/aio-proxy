import { ProviderProtocol } from "@aio-proxy/types";
import { describe, expect, test } from "bun:test";

import {
  geminiGenerateContentAdapter,
  geminiGenerateContentErrors,
  writeGeminiGenerateContentResponse,
  writeGeminiGenerateContentSSE,
} from "../../src/index";

function request(body: string, stream = false): Request {
  return new Request(
    `https://proxy.test/v1beta/models/url-model:${stream ? "streamGenerateContent" : "generateContent"}?key=test`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    },
  );
}

describe("geminiGenerateContentAdapter", () => {
  test("uses route context and maps generation, safety, function tools, reasoning, and writers", async () => {
    const safetySettings = [
      {
        category: "HARM_CATEGORY_HATE_SPEECH",
        threshold: "BLOCK_ONLY_HIGH",
      },
    ];
    const parameters = {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    };
    const raw = request(
      JSON.stringify({
        model: "body-model",
        contents: [{ role: "user", parts: [{ text: "hello" }] }],
        generationConfig: {
          maxOutputTokens: 128,
          temperature: 0.25,
          topP: 0.8,
          topK: 16,
          stopSequences: ["STOP"],
          seed: 7,
          thinkingConfig: { thinkingLevel: "HIGH" },
        },
        safetySettings,
        tools: [
          {
            functionDeclarations: [
              {
                name: "weather",
                description: "Get weather",
                parameters,
              },
            ],
          },
        ],
      }),
    );
    const context = { model: "route-model", stream: true };

    const parsed = await geminiGenerateContentAdapter.parse(raw, context);
    const invocation = geminiGenerateContentAdapter.modelInvocation(parsed, context);

    expect(geminiGenerateContentAdapter.protocol).toBe(ProviderProtocol.Gemini);
    expect(parsed.model).toBe("route-model");
    expect(geminiGenerateContentAdapter.model(parsed, context)).toBe("route-model");
    expect(geminiGenerateContentAdapter.variant(parsed, context)).toBe("HIGH");
    expect(geminiGenerateContentAdapter.wantsStream(parsed, context)).toBe(true);
    expect(geminiGenerateContentAdapter.wantsStream(parsed, { ...context, stream: false })).toBe(false);
    expect(invocation.settings).toEqual({
      providerOptions: { google: { safetySettings } },
      reasoning: "high",
      maxOutputTokens: 128,
      temperature: 0.25,
      topP: 0.8,
      topK: 16,
      stopSequences: ["STOP"],
      seed: 7,
    });
    expect(Object.keys(invocation.tools ?? {})).toEqual(["weather"]);
    expect(invocation.tools?.weather).toMatchObject({
      type: "function",
      description: "Get weather",
      inputSchema: { jsonSchema: parameters },
    });
    expect(geminiGenerateContentAdapter.modelJson).toBe(writeGeminiGenerateContentResponse);
    expect(geminiGenerateContentAdapter.modelSse).toBe(writeGeminiGenerateContentSSE);
    expect(geminiGenerateContentAdapter.errors).toBe(geminiGenerateContentErrors);
  });

  test("accepts only the current reasoning enum after normalization", async () => {
    for (const reasoning of ["none", "minimal", "low", "medium", "high", "xhigh"] as const) {
      const parsed = await geminiGenerateContentAdapter.parse(
        request(
          JSON.stringify({
            contents: [{ parts: [{ text: "hello" }] }],
            generationConfig: { thinkingConfig: { thinkingLevel: reasoning.toUpperCase() } },
          }),
        ),
        { model: "gemini", stream: false },
      );

      expect(
        geminiGenerateContentAdapter.modelInvocation(parsed, { model: "gemini", stream: false }).settings,
      ).toMatchObject({ reasoning });
    }

    const parsed = await geminiGenerateContentAdapter.parse(
      request(
        JSON.stringify({
          contents: [{ parts: [{ text: "hello" }] }],
          generationConfig: { thinkingConfig: { thinkingLevel: "EXTREME" } },
        }),
      ),
      { model: "gemini", stream: false },
    );

    expect(
      geminiGenerateContentAdapter.modelInvocation(parsed, { model: "gemini", stream: false }).settings,
    ).not.toHaveProperty("reasoning");
  });

  test("rewrites only the URL model segment and preserves request body bytes", async () => {
    const body = `{
  "model": "body-model",
  "contents": [{"parts": [{"text": "hello"}]}],
  "beta_field": true
}`;
    const raw = request(body, true);
    const context = { model: "route-alias", stream: true };
    const parsed = await geminiGenerateContentAdapter.parse(raw, context);

    const forwarded = await geminiGenerateContentAdapter.rawRequest(raw, parsed, "upstream/model + pro", context);
    const url = new URL(forwarded.url);

    expect(url.pathname).toBe("/v1beta/models/upstream%2Fmodel%20%2B%20pro:streamGenerateContent");
    expect(url.search).toBe("?key=test");
    expect(await forwarded.text()).toBe(body);
  });
});
