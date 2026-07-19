import { describe, expect, test } from "bun:test";

import {
  AiSdkProviderError,
  AnthropicMessagesTransformError,
  anthropicMessagesErrors,
  GeminiInlineDataTooLargeError,
  geminiGenerateContentErrors,
  OpenAIResponsesUnsupportedFeatureError,
  openAICompletionsErrors,
  openAIResponsesErrors,
  ProviderNotInstalledError,
} from "../../src/index";

async function body(response: Response | undefined): Promise<unknown> {
  if (response === undefined) {
    throw new Error("expected mapped response");
  }
  return response.json();
}

describe("protocol errors", () => {
  test("maps wrapped client aborts to protocol-native 499 envelopes", async () => {
    const cause = new Error("client disconnected");
    cause.name = "AbortError";
    const error = new AiSdkProviderError("provider", cause);

    const openAI = openAICompletionsErrors.provider(error);
    expect(openAI?.status).toBe(499);
    expect(await body(openAI)).toEqual({
      error: { code: "aborted", message: "client disconnected", type: "invalid_request_error" },
    });

    const anthropic = anthropicMessagesErrors.provider(error);
    expect(anthropic?.status).toBe(499);
    expect(await body(anthropic)).toEqual({
      type: "error",
      error: { type: "invalid_request_error", message: "client disconnected" },
    });

    const gemini = geminiGenerateContentErrors.provider(error);
    expect(gemini?.status).toBe(499);
    expect(await body(gemini)).toEqual({
      error: { code: 499, message: "client disconnected", status: "CANCELLED" },
    });
  });

  test("keeps wrapped timeouts as server errors", () => {
    const cause = new Error("upstream timed out");
    cause.name = "TimeoutError";
    const error = new AiSdkProviderError("provider", cause);

    expect(openAICompletionsErrors.provider(error)?.status).toBe(500);
    expect(anthropicMessagesErrors.provider(error)?.status).toBe(500);
    expect(geminiGenerateContentErrors.provider(error)?.status).toBe(500);
  });

  test("maps request errors to each inbound protocol", async () => {
    expect(await body(openAICompletionsErrors.requestError(new SyntaxError("bad")))).toEqual({
      error: { code: "invalid_request", message: "Invalid OpenAI Completions request", type: "invalid_request_error" },
    });
    expect(
      await body(
        openAIResponsesErrors.requestError(new OpenAIResponsesUnsupportedFeatureError("custom_tool", "tools")),
      ),
    ).toEqual({
      error: {
        code: "unsupported_feature",
        message: "OpenAI Responses feature is not supported: custom_tool",
        type: "unsupported_feature",
      },
    });
    expect(await body(anthropicMessagesErrors.requestError(new AnthropicMessagesTransformError("messages.1")))).toEqual(
      {
        type: "error",
        error: { type: "invalid_request_error", message: "Invalid Anthropic Messages request" },
      },
    );
    expect(
      await body(geminiGenerateContentErrors.requestError(new GeminiInlineDataTooLargeError("contents.0", 10, 11))),
    ).toEqual({
      error: {
        code: 413,
        message: "Gemini inlineData at contents.0 is 11 bytes; limit is 10",
        status: "RESOURCE_EXHAUSTED",
      },
    });
  });

  test("maps missing providers and declines truly unknown values", async () => {
    const missing = new ProviderNotInstalledError("p", "@vendor/provider");
    expect(openAICompletionsErrors.provider(missing)?.status).toBe(503);
    expect(anthropicMessagesErrors.provider(missing)?.status).toBe(503);
    expect(geminiGenerateContentErrors.provider(missing)?.status).toBe(503);
    expect(openAIResponsesErrors.provider(Symbol("unknown"))).toBeUndefined();
  });

  test("returns exact body-limit and model-not-found envelopes", async () => {
    expect(openAICompletionsErrors.tooLarge().status).toBe(413);
    expect(await body(anthropicMessagesErrors.modelNotFound("Model not found: x"))).toEqual({
      type: "error",
      error: { type: "not_found_error", message: "Model not found: x" },
    });
    expect(await body(geminiGenerateContentErrors.modelNotFound("Model not found: x"))).toEqual({
      error: { code: 404, message: "Model not found: x", status: "NOT_FOUND" },
    });
  });
});
