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

  test("accepts SSE data fields without a space after the colon", () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.OpenAICompatible,
        'data:{"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}\n\n',
      ),
    ).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 });
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

  test("extracts nested OpenAI Responses SSE usage", () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.OpenAIResponse,
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":8,"total_tokens":15}}}\n\n',
      ),
    ).toEqual({ inputTokens: 7, outputTokens: 8, totalTokens: 15 });
  });

  test("accepts CRLF SSE framing", () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.OpenAICompatible,
        'data: {"choices":[]}\r\n\r\ndata: {"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}\r\n\r\n',
      ),
    ).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 });
  });

  test("ignores empty and unparseable usage", () => {
    expect(extractPassthroughUsage(ProviderProtocol.OpenAICompatible, JSON.stringify({ usage: {} }))).toBeUndefined();
    expect(extractPassthroughUsage(ProviderProtocol.OpenAICompatible, "data: {not-json}\n\n")).toBeUndefined();
  });

  test("preserves OpenAI cache and reasoning dimensions", () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.OpenAICompatible,
        JSON.stringify({
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
            prompt_tokens_details: { cached_tokens: 6 },
            completion_tokens_details: { reasoning_tokens: 3 },
          },
        }),
      ),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      totalTokens: 14,
      cacheReadTokens: 6,
      reasoningTokens: 3,
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

  test("preserves Anthropic cache dimensions", () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.Anthropic,
        JSON.stringify({
          usage: {
            input_tokens: 11,
            output_tokens: 13,
            cache_read_input_tokens: 7,
            cache_creation_input_tokens: 5,
          },
        }),
      ),
    ).toEqual({
      inputTokens: 11,
      outputTokens: 13,
      totalTokens: 24,
      cacheReadTokens: 7,
      cacheWriteTokens: 5,
    });
  });

  test.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("merges split Anthropic SSE usage with %s framing", (_label, newline) => {
    const body = [
      "event: message_start",
      'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"cache_creation_input_tokens":5,"cache_read_input_tokens":7}}}',
      "",
      "event: message_delta",
      'data: {"type":"message_delta","usage":{"output_tokens":13}}',
      "",
    ].join(newline);

    expect(extractPassthroughUsage(ProviderProtocol.Anthropic, body)).toEqual({
      inputTokens: 11,
      outputTokens: 13,
      totalTokens: 24,
      cacheReadTokens: 7,
      cacheWriteTokens: 5,
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

  test("extracts the last Gemini streamGenerateContent JSON usage metadata", () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.Gemini,
        JSON.stringify([
          {
            usageMetadata: {
              promptTokenCount: 3,
              candidatesTokenCount: 4,
              totalTokenCount: 7,
            },
          },
          { candidates: [] },
          {
            usageMetadata: {
              promptTokenCount: 17,
              candidatesTokenCount: 19,
              totalTokenCount: 36,
              cachedContentTokenCount: 7,
              thoughtsTokenCount: 5,
            },
          },
        ]),
      ),
    ).toEqual({
      inputTokens: 17,
      outputTokens: 19,
      totalTokens: 36,
      cacheReadTokens: 7,
      reasoningTokens: 5,
    });
  });

  test("ignores Gemini streamGenerateContent JSON without usage metadata", () => {
    expect(extractPassthroughUsage(ProviderProtocol.Gemini, JSON.stringify([]))).toBeUndefined();
    expect(
      extractPassthroughUsage(ProviderProtocol.Gemini, JSON.stringify([{ candidates: [] }, { usageMetadata: {} }])),
    ).toBeUndefined();
  });

  test("preserves Gemini cache and reasoning dimensions", () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.Gemini,
        JSON.stringify({
          usageMetadata: {
            promptTokenCount: 17,
            candidatesTokenCount: 19,
            totalTokenCount: 36,
            cachedContentTokenCount: 7,
            thoughtsTokenCount: 5,
          },
        }),
      ),
    ).toEqual({
      inputTokens: 17,
      outputTokens: 19,
      totalTokens: 36,
      cacheReadTokens: 7,
      reasoningTokens: 5,
    });
  });
});
