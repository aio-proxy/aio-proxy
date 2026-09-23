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

test('accepts sparse raw chat choices and stream envelopes', () => {
  const response = {
    id: 'chatcmpl-upstream',
    object: 'chat.completion',
    choices: [{ message: { role: 'assistant', content: 'fallback ok' } }],
  };
  const choicesOnly = { choices: [{ message: { role: 'assistant', content: 'fallback ok' } }] };
  const choiceLess = { fallback: true };
  const event = {
    id: 'chatcmpl-upstream',
    choices: [{ delta: { content: 'fallback' }, index: 0, finish_reason: null }],
  };
  const omittedFinish = { id: 'chatcmpl-2', choices: [{ delta: { content: 'Hi' }, index: 0 }] };
  const idlessChunk = { choices: [{ delta: { content: 'hi' } }] };

  expect(OpenAICompletionsResponseSchema.parse(response)).toEqual(response);
  expect(OpenAICompletionsResponseSchema.parse(choicesOnly)).toEqual(choicesOnly);
  expect(OpenAICompletionsResponseSchema.parse(choiceLess)).toEqual(choiceLess);
  expect(OpenAICompletionsStreamEventSchema.parse(event)).toEqual(event);
  expect(OpenAICompletionsStreamEventSchema.parse(omittedFinish)).toEqual(omittedFinish);
  expect(OpenAICompletionsStreamEventSchema.parse(idlessChunk)).toEqual(idlessChunk);
});
