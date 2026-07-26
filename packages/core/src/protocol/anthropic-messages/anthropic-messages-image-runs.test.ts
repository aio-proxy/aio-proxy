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
  test('keeps image runs in user messages and image tool results in tool messages', async () => {
    const parsed = await anthropicMessagesAdapter.parse(
      request({
        model: 'claude-sonnet-4-5',
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_1', name: 'inspect', input: {} }],
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'before' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
              {
                type: 'tool_result',
                tool_use_id: 'toolu_1',
                content: [
                  { type: 'text', text: 'result' },
                  { type: 'image', source: { type: 'url', url: 'https://example.test/result.png' } },
                ],
              },
              { type: 'text', text: 'after' },
            ],
          },
        ],
      }),
      {},
    );

    expect(anthropicMessagesAdapter.modelInvocation(parsed, {}).messages.slice(1)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'before' },
          { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'AA==' } },
        ],
      },
      {
        role: 'tool',
        content: [
          expect.objectContaining({
            type: 'tool-result',
            toolCallId: 'toolu_1',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'result' },
                {
                  type: 'file',
                  mediaType: 'image/png',
                  data: { type: 'url', url: new URL('https://example.test/result.png') },
                  providerOptions: { aioProxy: { toolImage: true, trust: expect.any(String) } },
                },
              ],
            },
          }),
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'after' }] },
    ]);
  });
});
