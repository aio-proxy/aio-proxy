import { describe, expect, test } from 'bun:test';

import { createServer } from '#server-test-lifecycle';

import { aiSdkProvider, responsesRequest, textStream } from './openai-responses.test-support';

describe('OpenAI Responses routes', () => {
  test('Given ai-sdk provider When POST streams a tool call Then official function-call events are returned', async () => {
    const provider = aiSdkProvider(() =>
      textStream([
        { type: 'tool-input-start', id: 'call_1', toolName: 'get_weather' },
        { type: 'tool-input-delta', id: 'call_1', delta: '{"city":"Paris"}' },
        { type: 'tool-input-end', id: 'call_1' },
      ]),
    );
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });

    const response = await app.request('/v1/responses', {
      body: JSON.stringify(responsesRequest),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const eventTypes = (await response.text())
      .trim()
      .split('\n\n')
      .map((frame) => JSON.parse(frame.split('\n')[1]?.slice('data: '.length) ?? 'null').type);

    expect(eventTypes).toEqual([
      'response.created',
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
  });

  test('Given ai-sdk provider When POST is non-stream with a tool call Then function_call output is returned', async () => {
    const provider = aiSdkProvider(() =>
      textStream([
        { type: 'tool-input-start', id: 'call_1', toolName: 'get_weather' },
        { type: 'tool-input-delta', id: 'call_1', delta: '{"city":"Paris"}' },
        { type: 'tool-input-end', id: 'call_1' },
      ]),
    );
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });

    const response = await app.request('/v1/responses', {
      body: JSON.stringify({ ...responsesRequest, stream: false }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(await response.json()).toMatchObject({
      output: [
        {
          type: 'function_call',
          id: expect.stringMatching(/^fc_/),
          call_id: 'call_1',
          name: 'get_weather',
          arguments: '{"city":"Paris"}',
          status: 'completed',
        },
      ],
    });
  });
});
