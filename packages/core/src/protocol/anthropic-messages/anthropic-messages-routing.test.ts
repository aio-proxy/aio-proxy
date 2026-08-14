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

    expect(anthropicMessagesAdapter.dimensions(parsed, {})).toEqual({ thinking: true, effort: 'medium' });
  });

  test('maps enabled, disabled+effort, and null speed', async () => {
    const enabled = await anthropicMessagesAdapter.parse(
      request({
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 8192,
        thinking: { type: 'enabled', budget_tokens: 2048 },
      }),
      {},
    );
    expect(anthropicMessagesAdapter.dimensions(enabled, {})).toEqual({ thinking: true });

    const disabled = await anthropicMessagesAdapter.parse(
      request({
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 8192,
        thinking: { type: 'disabled' },
        output_config: { effort: 'high' },
      }),
      {},
    );
    expect(anthropicMessagesAdapter.dimensions(disabled, {})).toEqual({ thinking: false });

    const nullSpeed = await anthropicMessagesAdapter.parse(
      request({
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 8192,
        speed: null,
      }),
      {},
    );
    expect(anthropicMessagesAdapter.dimensions(nullSpeed, {})).toEqual({});
  });

  test('maps speed and service_tier onto the speed axis with in-field precedence', async () => {
    const parse = (extra: object) =>
      anthropicMessagesAdapter.parse(
        request({
          model: 'claude-opus-4-6',
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 8192,
          ...extra,
        }),
        {},
      );

    expect(anthropicMessagesAdapter.dimensions(await parse({ speed: 'fast' }), {})).toEqual({ speed: 'fast' });
    // Non-enum in-field speed omits the axis and must NOT fall through to service_tier.
    expect(anthropicMessagesAdapter.dimensions(await parse({ speed: 'turbo', service_tier: 'priority' }), {})).toEqual(
      {},
    );
    // Absent (or null) speed may fall through to service_tier.
    expect(anthropicMessagesAdapter.dimensions(await parse({ service_tier: 'flex' }), {})).toEqual({ speed: 'flex' });
    expect(anthropicMessagesAdapter.dimensions(await parse({ speed: null, service_tier: 'priority' }), {})).toEqual({
      speed: 'fast',
    });
    expect(anthropicMessagesAdapter.dimensions(await parse({ service_tier: 'standard_only' }), {})).toEqual({});
  });
});
