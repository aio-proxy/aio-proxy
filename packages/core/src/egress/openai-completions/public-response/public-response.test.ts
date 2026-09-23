import { expect, test } from 'bun:test';

import { OpenAICompletionsResponseSchema, OpenAICompletionsStreamEventSchema } from './public-response';

test('preserves provider extensions at every chat completion response object level', () => {
  const response = {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-test',
    system_fingerprint: 'fp_1',
    choices: [
      {
        finish_reason: 'tool_calls',
        index: 0,
        logprobs: null,
        provider_choice: 'choice-extension',
        message: {
          role: 'assistant',
          content: null,
          refusal: null,
          provider_message: 'message-extension',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              provider_tool_call: 'call-extension',
              function: { name: 'lookup', arguments: '{}', provider_function: 'function-extension' },
            },
          ],
        },
      },
    ],
  };

  expect(OpenAICompletionsResponseSchema.parse(response)).toEqual(response);
});

test('preserves provider extensions in chat completion stream events', () => {
  const event = {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-test',
    service_tier: 'priority',
    choices: [{ delta: { content: 'Hello' }, index: 0, finish_reason: null, provider_choice: 'extension' }],
  };

  expect(OpenAICompletionsStreamEventSchema.parse(event)).toEqual(event);
});

test('accepts a raw chat completion without optional provider envelope fields', () => {
  const response = { id: 'chatcmpl-upstream', object: 'chat.completion', choices: [] };

  expect(OpenAICompletionsResponseSchema.parse(response)).toEqual(response);
});
