import { expect, test } from 'bun:test';

import { OpenAIResponsesResponseSchema } from './public-response';

const response = {
  id: 'resp_1',
  object: 'response',
  created_at: 0,
  model: 'gpt-test',
  output_text: '',
};

test('accepts hosted and provider-defined output items forwarded by a raw Responses provider', () => {
  const raw = {
    ...response,
    status: 'completed',
    output: [
      { id: 'ws_1', type: 'web_search_call', status: 'completed' },
      { id: 'fs_1', type: 'file_search_call', status: 'completed' },
      { id: 'ci_1', type: 'code_interpreter_call', status: 'completed' },
      { id: 'provider_1', type: 'provider_tool_result', status: 'completed' },
    ],
  };

  expect(OpenAIResponsesResponseSchema.parse(raw)).toEqual(raw);
});

test('accepts other standard statuses forwarded by a raw Responses provider', () => {
  for (const status of ['incomplete', 'queued', 'cancelled']) {
    const raw = { ...response, status, output: [] };
    expect(OpenAIResponsesResponseSchema.parse(raw)).toEqual(raw);
  }
});
