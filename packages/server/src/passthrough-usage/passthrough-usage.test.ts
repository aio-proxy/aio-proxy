import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { extractPassthroughObservation, extractPassthroughUsage } from './index';

describe('passthrough usage extraction', () => {
  test('extracts OpenAI Chat JSON usage', () => {
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

  test('extracts OpenAI Chat SSE usage', () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.OpenAICompatible,
        'data: {"choices":[]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}\n\n' +
          'data: [DONE]\n\n',
      ),
    ).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
    });
  });

  test('accepts SSE data fields without a space after the colon', () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.OpenAICompatible,
        'data:{"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}\n\n',
      ),
    ).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 });
  });

  test('extracts OpenAI Responses JSON usage', () => {
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

  test('extracts nested OpenAI Responses SSE usage', () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.OpenAIResponse,
        'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":7,"output_tokens":8,"total_tokens":15}}}\n\n',
      ),
    ).toEqual({ inputTokens: 7, outputTokens: 8, totalTokens: 15 });
  });

  test('treats a blank completed OpenAI Responses id as absent', () => {
    expect(
      extractPassthroughObservation(
        ProviderProtocol.OpenAIResponse,
        JSON.stringify({ id: '   ', status: 'completed' }),
      ),
    ).toEqual({});
  });

  test('accepts CRLF SSE framing', () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.OpenAICompatible,
        'data: {"choices":[]}\r\n\r\ndata: {"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}\r\n\r\n',
      ),
    ).toEqual({ inputTokens: 4, outputTokens: 6, totalTokens: 10 });
  });

  test('ignores empty and unparseable usage', () => {
    expect(extractPassthroughUsage(ProviderProtocol.OpenAICompatible, JSON.stringify({ usage: {} }))).toBeUndefined();
    expect(extractPassthroughUsage(ProviderProtocol.OpenAICompatible, 'data: {not-json}\n\n')).toBeUndefined();
  });

  test('preserves OpenAI cache and reasoning dimensions', () => {
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
});
