import type { TokenCountInput } from "@aio-proxy/plugin-sdk";

import { ProviderProtocol } from "@aio-proxy/types";
import { expect, test } from "bun:test";

import { countFixture, provider, requestedModel } from "./token-count.test-support";

test("materializes custom tools for the token-count target protocol", async () => {
  let countedInvocation: TokenCountInput["invocation"] | undefined;
  const fixture = countFixture([
    provider({
      id: "responses",
      targetProtocol: ProviderProtocol.OpenAIResponse,
      tokenCount: async ({ invocation }) => {
        countedInvocation = invocation;
        return { inputTokens: 9 };
      },
    }),
  ]);

  const response = await fixture.openAIResponses();

  expect(await response.json()).toEqual({ input_tokens: 9 });
  expect(countedInvocation?.tools?.exec).toMatchObject({ type: "provider" });
  expect(countedInvocation?.messages[0]).toMatchObject({
    role: "assistant",
    content: [{ type: "tool-call", toolCallId: "call_1", toolName: "exec", input: "pwd" }],
  });
});

test("skips token counters that cannot preserve image detail", async () => {
  let incompatibleCalls = 0;
  let countedInvocation: TokenCountInput["invocation"] | undefined;
  const fixture = countFixture([
    provider({
      id: "anthropic",
      targetProtocol: ProviderProtocol.Anthropic,
      tokenCount: async () => {
        incompatibleCalls += 1;
        return { inputTokens: 1 };
      },
    }),
    provider({
      id: "responses",
      targetProtocol: ProviderProtocol.OpenAIResponse,
      tokenCount: async ({ invocation }) => {
        countedInvocation = invocation;
        return { inputTokens: 9 };
      },
    }),
  ]);

  const response = await fixture.openAIResponses(
    jsonRequest("https://proxy.test/v1/responses/input_tokens", {
      model: requestedModel,
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,AA==", detail: "low" }],
        },
      ],
    }),
  );

  expect(await response.json()).toEqual({ input_tokens: 9 });
  expect(incompatibleCalls).toBe(0);
  expect(countedInvocation?.messages[0]).toMatchObject({
    role: "user",
    content: [{ providerOptions: { openai: { imageDetail: "low" } } }],
  });
});

test("skips token counters that cannot preserve Gemini model-history images", async () => {
  let incompatibleCalls = 0;
  let countedInvocation: TokenCountInput["invocation"] | undefined;
  const fixture = countFixture([
    provider({
      id: "anthropic",
      targetProtocol: ProviderProtocol.Anthropic,
      tokenCount: async () => {
        incompatibleCalls += 1;
        return { inputTokens: 1 };
      },
    }),
    provider({
      id: "gemini",
      targetProtocol: ProviderProtocol.Gemini,
      tokenCount: async ({ invocation }) => {
        countedInvocation = invocation;
        return { inputTokens: 9 };
      },
    }),
  ]);

  const response = await fixture.gemini(
    jsonRequest(`https://proxy.test/v1beta/models/${requestedModel}:countTokens`, {
      contents: [
        {
          role: "model",
          parts: [
            { inlineData: { mimeType: "image/png", data: "AA==" } },
            { fileData: { mimeType: "image/png", fileUri: "https://example.test/prior.png" } },
          ],
        },
      ],
    }),
  );

  expect(await response.json()).toEqual({ totalTokens: 9 });
  expect(incompatibleCalls).toBe(0);
  expect(countedInvocation?.messages[0]).toEqual({
    role: "assistant",
    content: [
      { type: "file", mediaType: "image/png", data: { type: "data", data: "AA==" } },
      {
        type: "file",
        mediaType: "image/png",
        data: { type: "reference", reference: { google: "https://example.test/prior.png" } },
      },
    ],
  });
});

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
