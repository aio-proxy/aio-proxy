import { expect, test } from 'bun:test';

import { AnthropicMessageResponseSchema, AnthropicMessagesStreamEventSchema } from './public-response';

test('accepts server-tool and provider-defined blocks forwarded by a raw Anthropic provider', () => {
  const raw = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [
      { type: 'server_tool_use', id: 'srvtool_1', name: 'web_search', input: { query: 'weather' } },
      { type: 'web_search_tool_result', tool_use_id: 'srvtool_1', content: [] },
      { type: 'provider_result', data: 'provider extension' },
    ],
    model: 'claude-test',
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };

  expect(AnthropicMessageResponseSchema.parse(raw)).toEqual(raw);
});

test('accepts sparse provider-defined objects forwarded by a raw Anthropic provider', () => {
  expect(AnthropicMessageResponseSchema.parse({ fallback: true })).toEqual({ fallback: true });
  expect(AnthropicMessagesStreamEventSchema.parse({ message: { usage: { input_tokens: 1.5 } } })).toEqual({
    message: { usage: { input_tokens: 1.5 } },
  });
  expect(AnthropicMessagesStreamEventSchema.parse({ usage: { output_tokens: 13 } })).toEqual({
    usage: { output_tokens: 13 },
  });
});
