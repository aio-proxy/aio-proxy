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
});
