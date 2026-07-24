import type { LanguageModelV4, LanguageModelV4CallOptions } from "@ai-sdk/provider";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { expect, test } from "bun:test";

import { imageFilePart } from ".";

const prompt = [
  {
    role: "assistant" as const,
    content: [{ type: "tool-call" as const, toolCallId: "call_1", toolName: "inspect", input: {} }],
  },
  {
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolCallId: "call_1",
        toolName: "inspect",
        output: {
          type: "content" as const,
          value: [
            { type: "text" as const, text: "before" },
            {
              type: "file" as const,
              mediaType: "image/png",
              data: { type: "data" as const, data: "AA==" },
              providerOptions: {
                openai: { imageDetail: "low" },
                aioProxy: { toolImage: true },
              },
            },
          ],
        },
      },
    ],
  },
] satisfies LanguageModelV4CallOptions["prompt"];

test("OpenAI Responses emits input_image inside function_call_output", async () => {
  const capture = requestCapture();
  const model = createOpenAI({ apiKey: "test", fetch: capture.fetch }).responses("gpt-5.6-sol");

  const body = await capture.generate(model);

  expect(body).toEqual({
    model: "gpt-5.6-sol",
    input: [
      { type: "function_call", call_id: "call_1", name: "inspect", arguments: "{}" },
      {
        type: "function_call_output",
        call_id: "call_1",
        output: [
          { type: "input_text", text: "before" },
          { type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" },
        ],
      },
    ],
  });
});

test("Anthropic emits image inside tool_result content", async () => {
  const capture = requestCapture();
  const model = createAnthropic({ apiKey: "test", fetch: capture.fetch }).languageModel("claude-sonnet-4-5");

  const body = await capture.generate(model);

  expect(body).toMatchObject({
    model: "claude-sonnet-4-5",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "inspect", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: [
              { type: "text", text: "before" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } },
            ],
          },
        ],
      },
    ],
  });
});

test("Gemini 3 emits inlineData inside functionResponse.parts", async () => {
  const capture = requestCapture();
  const model = createGoogleGenerativeAI({ apiKey: "test", fetch: capture.fetch }).languageModel(
    "gemini-3-flash-preview",
  );

  const body = await capture.generate(model);

  expect(body).toEqual({
    generationConfig: {},
    contents: [
      {
        role: "model",
        parts: [
          {
            functionCall: { id: "call_1", name: "inspect", args: {} },
            thoughtSignature: "skip_thought_signature_validator",
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              id: "call_1",
              name: "inspect",
              response: { name: "inspect", content: "before" },
              parts: [{ inlineData: { mimeType: "image/png", data: "AA==" } }],
            },
          },
        ],
      },
    ],
  });
});

test("Gemini sends an ordinary remote image URL without downloading it", async () => {
  const capture = requestCapture();
  const model = createGoogleGenerativeAI({ apiKey: "test", fetch: capture.fetch }).languageModel(
    "gemini-3-flash-preview",
  );
  const image = imageFilePart({ type: "url", url: "https://example.test/photo.png" });
  if (image === undefined) throw new Error("image fixture was rejected");

  const body = await capture.generate(model, [{ role: "user", content: [image] }]);

  expect(body).toMatchObject({
    contents: [
      {
        role: "user",
        parts: [{ fileData: { mimeType: "image/png", fileUri: "https://example.test/photo.png" } }],
      },
    ],
  });
});

function requestCapture(): {
  readonly fetch: typeof globalThis.fetch;
  readonly generate: (model: LanguageModelV4, input?: LanguageModelV4CallOptions["prompt"]) => Promise<unknown>;
} {
  let body: unknown;
  const captureError = new Error("request captured");
  const fetcher = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    body = JSON.parse(String(init?.body));
    throw captureError;
  };
  return {
    fetch: fetcher as typeof globalThis.fetch,
    async generate(model, input = prompt) {
      try {
        await model.doGenerate({ prompt: input });
      } catch (error) {
        if (!hasCause(error, captureError)) throw error;
      }
      if (body === undefined) throw new Error("provider did not issue a request");
      return body;
    },
  };
}

function hasCause(error: unknown, target: Error): boolean {
  const seen = new Set<Error>();
  let current = error;
  while (current instanceof Error && !seen.has(current)) {
    if (current === target) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}
