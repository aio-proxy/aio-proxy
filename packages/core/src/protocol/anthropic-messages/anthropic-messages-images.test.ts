import { describe, expect, test } from 'bun:test';

import { anthropicMessagesAdapter } from '../../index';

function request(body: object): Request {
  return new Request('https://proxy.test/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('anthropicMessagesAdapter image boundaries', () => {
  test('flushes user content on kind changes and preserves part provider options', async () => {
    const parsed = await anthropicMessagesAdapter.parse(
      request({
        model: 'claude-sonnet-4-5',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'Check both tools.', signature: 'sig-123' },
              {
                type: 'text',
                text: 'Calling tools.',
                cache_control: { type: 'ephemeral', ttl: '1h' },
              },
              {
                type: 'tool_use',
                id: 'toolu_weather',
                name: 'weather',
                input: { city: 'Paris' },
                cache_control: { type: 'ephemeral', ttl: '5m' },
              },
              {
                type: 'tool_use',
                id: 'toolu_clock',
                name: 'clock',
                input: { zone: 'UTC' },
              },
            ],
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Before ',
                cache_control: { type: 'ephemeral', ttl: '5m' },
              },
              { type: 'text', text: 'results.' },
              {
                type: 'tool_result',
                tool_use_id: 'toolu_weather',
                content: 'Sunny',
                cache_control: { type: 'ephemeral', ttl: '1h' },
              },
              {
                type: 'tool_result',
                tool_use_id: 'toolu_clock',
                content: [{ type: 'text', text: '12:00' }],
              },
              { type: 'text', text: 'After.' },
            ],
          },
        ],
      }),
      {},
    );

    expect(anthropicMessagesAdapter.modelInvocation(parsed, {}).messages).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'reasoning',
            text: 'Check both tools.',
            providerOptions: { anthropic: { signature: 'sig-123' } },
          },
          {
            type: 'text',
            text: 'Calling tools.',
            providerOptions: { anthropic: { cache_control: { type: 'ephemeral', ttl: '1h' } } },
          },
          {
            type: 'tool-call',
            toolCallId: 'toolu_weather',
            toolName: 'weather',
            input: { city: 'Paris' },
            providerOptions: { anthropic: { cache_control: { type: 'ephemeral', ttl: '5m' } } },
          },
          {
            type: 'tool-call',
            toolCallId: 'toolu_clock',
            toolName: 'clock',
            input: { zone: 'UTC' },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Before ',
            providerOptions: { anthropic: { cache_control: { type: 'ephemeral', ttl: '5m' } } },
          },
          { type: 'text', text: 'results.' },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'toolu_weather',
            toolName: 'weather',
            output: { type: 'text', value: 'Sunny' },
            providerOptions: { anthropic: { cache_control: { type: 'ephemeral', ttl: '1h' } } },
          },
          {
            type: 'tool-result',
            toolCallId: 'toolu_clock',
            toolName: 'clock',
            output: { type: 'content', value: [{ type: 'text', text: '12:00' }] },
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'After.' }] },
    ]);
  });
});
