import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import {
  anthropicMessagesAdapter,
  anthropicMessagesErrors,
  parseAnthropicMessages,
  writeAnthropicMessagesResponse,
  writeAnthropicMessagesSSE,
} from '../../index';

function request(body: object): Request {
  return new Request('https://proxy.test/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('anthropicMessagesAdapter', () => {
  test('preserves an ordered tool exchange, rewrites only the model, and exposes current boundaries', async () => {
    const body = {
      model: 'alias',
      system: [
        {
          type: 'text',
          text: 'Use tools.',
          cache_control: { type: 'ephemeral', ttl: '5m' },
        },
      ],
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_weather',
              name: 'weather',
              input: { city: 'Paris' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_weather',
              content: 'Sunny',
            },
            { type: 'text', text: 'Summarize.' },
          ],
        },
      ],
      beta_field: { enabled: true },
    };
    const raw = request(body);

    const parsed = await anthropicMessagesAdapter.parse(raw, {});
    const invocation = anthropicMessagesAdapter.modelInvocation(parsed, {});

    expect(anthropicMessagesAdapter.protocol).toBe(ProviderProtocol.Anthropic);
    expect(anthropicMessagesAdapter.model(parsed, {})).toBe('alias');
    expect(anthropicMessagesAdapter.dimensions(parsed, {})).toEqual({});
    expect(anthropicMessagesAdapter.wantsStream(parsed, {})).toBe(false);
    expect(invocation.messages[0]).toEqual({
      role: 'system',
      content: 'Use tools.',
      providerOptions: {
        anthropic: {
          system: [
            {
              type: 'text',
              text: 'Use tools.',
              cache_control: { type: 'ephemeral', ttl: '5m' },
            },
          ],
        },
      },
    });
    expect(invocation.messages.slice(1)).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'toolu_weather',
            toolName: 'weather',
            input: { city: 'Paris' },
          },
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
          },
        ],
      },
      { role: 'user', content: [{ type: 'text', text: 'Summarize.' }] },
    ]);
    expect(await (await anthropicMessagesAdapter.rawRequest(raw, parsed, 'upstream', new Set(), {})).json()).toEqual({
      ...body,
      model: 'upstream',
    });
    expect(anthropicMessagesAdapter.modelJson).toBe(writeAnthropicMessagesResponse);
    expect(anthropicMessagesAdapter.modelSse).toBe(writeAnthropicMessagesSSE);
    expect(anthropicMessagesAdapter.errors).toBe(anthropicMessagesErrors);
  });

  for (const [label, stream, wantsStream, settings] of [
    ['absent', undefined, false, {}],
    ['false', false, false, { stream: false }],
    ['true', true, true, { stream: true }],
  ] as const) {
    test(`handles stream ${label}`, async () => {
      const parsed = await anthropicMessagesAdapter.parse(
        request({
          model: 'claude-sonnet-4-5',
          messages: [{ role: 'user', content: 'hello' }],
          ...(stream === undefined ? {} : { stream }),
        }),
        {},
      );

      expect(anthropicMessagesAdapter.wantsStream(parsed, {})).toBe(wantsStream);
      expect(anthropicMessagesAdapter.modelInvocation(parsed, {}).settings).toEqual(settings);
    });
  }

  test('clamps output_config.effort to the highest supported level in the raw body', async () => {
    const body = {
      model: 'src',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
    };
    const raw = new Request('https://x/v1/messages', { method: 'POST', body: JSON.stringify(body) });
    const parsed = parseAnthropicMessages(structuredClone(body));
    const forwarded = await anthropicMessagesAdapter.rawRequest(
      raw,
      parsed,
      'upstream',
      new Set(['low', 'medium', 'high']),
      {},
    );
    expect(await forwarded.json()).toMatchObject({ model: 'upstream', output_config: { effort: 'high' } });
  });

  test('leaves effort untouched in the raw body when the supported set is empty', async () => {
    const body = {
      model: 'upstream',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
    };
    const raw = new Request('https://x/v1/messages', { method: 'POST', body: JSON.stringify(body) });
    const parsed = parseAnthropicMessages(structuredClone(body));
    const forwarded = await anthropicMessagesAdapter.rawRequest(raw, parsed, 'upstream', new Set(), {});
    expect(await forwarded.json()).toMatchObject({ output_config: { effort: 'xhigh' } });
  });

  test('clamps the adaptive thinking effort in the model invocation', () => {
    const parsed = parseAnthropicMessages({
      model: 'm',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'adaptive' },
      output_config: { effort: 'xhigh' },
    });
    const invocation = anthropicMessagesAdapter.modelInvocation(parsed, {});
    const clamped = anthropicMessagesAdapter.modelInvocationForTarget(
      invocation,
      undefined,
      new Set(['low', 'medium', 'high']),
    );
    const thinking = (clamped.settings?.providerOptions as { aioProxy?: { thinking?: { effort?: string } } })?.aioProxy
      ?.thinking;
    expect(thinking?.effort).toBe('high');
  });
});
