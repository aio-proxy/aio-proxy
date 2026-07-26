import { describe, expect, test } from 'bun:test';

import { anthropicMessagesAdapter } from '../../index';

function request(body: object): Request {
  return new Request('https://proxy.test/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('anthropicMessagesAdapter', () => {
  test('clones the raw request when the resolved model is unchanged', async () => {
    const body = {
      model: 'same',
      messages: [{ role: 'user', content: 'hello' }],
      beta_field: true,
    };
    const raw = request(body);
    const parsed = await anthropicMessagesAdapter.parse(raw, {});

    const forwarded = await anthropicMessagesAdapter.rawRequest(raw, parsed, 'same', {});

    expect(forwarded).not.toBe(raw);
    expect(await forwarded.json()).toEqual(body);
  });

  test('preserves an empty user content array as an empty user message', async () => {
    const parsed = await anthropicMessagesAdapter.parse(
      request({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: [] }],
      }),
      {},
    );

    expect(anthropicMessagesAdapter.modelInvocation(parsed, {}).messages).toEqual([{ role: 'user', content: [] }]);
  });

  test('routes adaptive effort as the alias variant', async () => {
    const parsed = await anthropicMessagesAdapter.parse(
      request({
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 32768,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' },
      }),
      {},
    );

    expect(anthropicMessagesAdapter.variant(parsed, {})).toBe('medium');
  });
});
