import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { extractPassthroughUsage } from './index';

describe('passthrough usage extraction', () => {
  test('extracts Anthropic JSON usage', () => {
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

  test('treats nullable Anthropic cache usage as absent', () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.Anthropic,
        JSON.stringify({
          usage: {
            input_tokens: 11,
            output_tokens: 13,
            cache_read_input_tokens: null,
            cache_creation_input_tokens: null,
          },
        }),
      ),
    ).toEqual({
      inputTokens: 11,
      outputTokens: 13,
      totalTokens: 24,
    });
  });

  test('preserves Anthropic cache dimensions', () => {
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
      totalTokens: 36,
      cacheReadTokens: 7,
      cacheWriteTokens: 5,
    });
  });

  test.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])('merges split Anthropic SSE usage with %s framing', (_label, newline) => {
    const body = [
      'event: message_start',
      'data: {"type":"message_start","message":{"usage":{"input_tokens":11,"cache_creation_input_tokens":5,"cache_read_input_tokens":7}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"input_tokens":null,"output_tokens":13,"cache_creation_input_tokens":null,"cache_read_input_tokens":null}}',
      '',
    ].join(newline);

    expect(extractPassthroughUsage(ProviderProtocol.Anthropic, body)).toEqual({
      inputTokens: 11,
      outputTokens: 13,
      totalTokens: 36,
      cacheReadTokens: 7,
      cacheWriteTokens: 5,
    });
  });

  test('extracts OpenAI-compatible audio tokens from usage details', () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.OpenAICompatible,
        JSON.stringify({
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            prompt_tokens_details: { audio_tokens: 30 },
            completion_tokens_details: { audio_tokens: 10 },
          },
        }),
      ),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      inputAudioTokens: 30,
      outputAudioTokens: 10,
    });
  });

  test('omits OpenAI-compatible audio tokens when details are absent', () => {
    const usage = extractPassthroughUsage(
      ProviderProtocol.OpenAICompatible,
      JSON.stringify({
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
        },
      }),
    );

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(usage).not.toHaveProperty('inputAudioTokens');
    expect(usage).not.toHaveProperty('outputAudioTokens');
  });

  test('extracts official OpenAI Images usage tokens', () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.OpenAIImage,
        JSON.stringify({
          created: 10,
          data: [{ b64_json: 'abc' }],
          usage: {
            input_tokens: 8,
            output_tokens: 1056,
            total_tokens: 1064,
            input_tokens_details: { image_tokens: 4, text_tokens: 4 },
          },
        }),
      ),
    ).toEqual({
      inputTokens: 8,
      outputTokens: 1056,
      totalTokens: 1064,
    });
  });

  test('does not extract audio tokens from Responses-protocol usage', () => {
    const usage = extractPassthroughUsage(
      ProviderProtocol.OpenAIResponse,
      JSON.stringify({
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          input_tokens_details: { audio_tokens: 30 },
          output_tokens_details: { audio_tokens: 10 },
        },
      }),
    );

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(usage).not.toHaveProperty('inputAudioTokens');
    expect(usage).not.toHaveProperty('outputAudioTokens');
  });
});
