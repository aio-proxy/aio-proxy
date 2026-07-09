import { describe, expect, test } from "bun:test";
import { ProviderProtocol } from "@aio-proxy/types";
import { extractPassthroughUsage } from "../src/passthrough-usage";

describe("passthrough usage extraction", () => {
  test("extracts OpenAI Chat JSON usage", () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.OpenAICompatible,
        JSON.stringify({
          usage: {
            prompt_tokens: 3,
            completion_tokens: 2,
            total_tokens: 5,
          },
        }),
      ),
    ).toEqual({
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
    });
  });

  test("extracts OpenAI Chat SSE usage", () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.OpenAICompatible,
        'data: {"choices":[]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}\n\n' +
          "data: [DONE]\n\n",
      ),
    ).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
    });
  });

  test("extracts OpenAI Responses JSON usage", () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.OpenAIResponse,
        JSON.stringify({
          usage: {
            input_tokens: 7,
            output_tokens: 8,
            total_tokens: 15,
          },
        }),
      ),
    ).toEqual({
      inputTokens: 7,
      outputTokens: 8,
      totalTokens: 15,
    });
  });

  test("extracts Anthropic JSON usage", () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.Anthropic,
        JSON.stringify({
          usage: {
            input_tokens: 11,
            output_tokens: 13,
          },
        }),
      ),
    ).toEqual({
      inputTokens: 11,
      outputTokens: 13,
      totalTokens: 24,
    });
  });

  test("extracts Gemini JSON usage metadata", () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.Gemini,
        JSON.stringify({
          usageMetadata: {
            promptTokenCount: 17,
            candidatesTokenCount: 19,
            totalTokenCount: 36,
          },
        }),
      ),
    ).toEqual({
      inputTokens: 17,
      outputTokens: 19,
      totalTokens: 36,
    });
  });
});
