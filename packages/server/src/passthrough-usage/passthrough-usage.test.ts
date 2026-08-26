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

  test('counts Responses JSON image/web-search items alongside tokens', () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.OpenAIResponse,
        JSON.stringify({
          usage: { input_tokens: 7, output_tokens: 8, total_tokens: 15 },
          output: [
            { type: 'image_generation_call' },
            { type: 'image_generation_call' },
            { type: 'web_search_call' },
            { type: 'message' },
          ],
        }),
      ),
    ).toEqual({ inputTokens: 7, outputTokens: 8, totalTokens: 15, imageCount: 2, webSearchCount: 1 });
  });

  test('surfaces Responses item counts even when token usage is absent', () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.OpenAIResponse,
        JSON.stringify({ output: [{ type: 'image_generation_call' }, { type: 'web_search_call' }] }),
      ),
    ).toEqual({ imageCount: 1, webSearchCount: 1 });
  });

  test('omits Responses item counts when no such items are present', () => {
    const usage = extractPassthroughUsage(
      ProviderProtocol.OpenAIResponse,
      JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }, output: [{ type: 'message' }] }),
    );
    expect(usage).toEqual({ inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    expect(usage?.imageCount).toBeUndefined();
    expect(usage?.webSearchCount).toBeUndefined();
  });

  test('does not count output items for non-Responses protocols', () => {
    const usage = extractPassthroughUsage(
      ProviderProtocol.OpenAICompatible,
      JSON.stringify({
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        output: [{ type: 'image_generation_call' }, { type: 'web_search_call' }],
      }),
    );
    expect(usage?.imageCount).toBeUndefined();
    expect(usage?.webSearchCount).toBeUndefined();
  });

  test('counts Responses SSE output_item.done items alongside terminal usage', () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.OpenAIResponse,
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"image_generation_call"}}\n\n' +
          'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"web_search_call"}}\n\n' +
          'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"web_search_call"}}\n\n' +
          'event: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n',
      ),
    ).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5, imageCount: 1, webSearchCount: 2 });
  });

  test('counts Images SSE completed events alongside official tokens', () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.OpenAIImage,
        'event: image_generation.partial_image\ndata: {"type":"image_generation.partial_image","b64_json":"p"}\n\n' +
          'event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"a"}\n\n' +
          'event: image_generation.completed\ndata: {"type":"image_generation.completed","b64_json":"b","usage":{"input_tokens":8,"output_tokens":16,"total_tokens":24}}\n\n',
      ),
    ).toEqual({ inputTokens: 8, outputTokens: 16, totalTokens: 24, imageCount: 2 });
  });
});
