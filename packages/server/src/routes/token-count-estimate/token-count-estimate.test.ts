import { expect, test } from 'bun:test';

import { anthropicMessagesAdapter } from '@aio-proxy/core';

import { estimateInputTokens } from './token-count-estimate';

// Builds a ModelInvocation the same way the route does, from a parsed request.
async function invocationFrom(body: Record<string, unknown>) {
  const request = new Request('https://proxy.test/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', max_tokens: 16, ...body }),
  });
  const parsed = await anthropicMessagesAdapter.parse(request, {});
  return anthropicMessagesAdapter.modelInvocation(parsed, {});
}

test('estimates at least one token for trivial input', async () => {
  const invocation = await invocationFrom({ messages: [{ role: 'user', content: 'hi' }] });
  expect(estimateInputTokens('anthropic', invocation)).toBeGreaterThanOrEqual(1);
});

test('CJK text estimates denser than the same character count of latin text', async () => {
  const cjk = await invocationFrom({ messages: [{ role: 'user', content: '你好世界一二三四五六七八' }] });
  const latin = await invocationFrom({ messages: [{ role: 'user', content: 'abcdefghijkl' }] });
  // 12 CJK chars ~ 12 * 1.21 tokens; 12 latin chars ~ 1-2 words. CJK must score higher.
  expect(estimateInputTokens('anthropic', cjk)).toBeGreaterThan(estimateInputTokens('anthropic', latin));
});

test('ignores base64 image parts instead of counting their bytes', async () => {
  const bigBase64 = 'A'.repeat(20_000);
  const withImage = await invocationFrom({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bigBase64 } },
        ],
      },
    ],
  });
  const textOnly = await invocationFrom({ messages: [{ role: 'user', content: 'describe this' }] });
  // The 20k base64 blob must not dominate the estimate the way bytes/64 (~310 tokens) would.
  expect(estimateInputTokens('anthropic', withImage)).toBeLessThan(50);
  expect(estimateInputTokens('anthropic', withImage)).toBe(estimateInputTokens('anthropic', textOnly));
});

test('counts tool schemas because they are sent to the model verbatim', async () => {
  const withTools = await invocationFrom({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      {
        name: 'search',
        description: 'search the web',
        input_schema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ],
  });
  const noTools = await invocationFrom({ messages: [{ role: 'user', content: 'hi' }] });
  expect(estimateInputTokens('anthropic', withTools)).toBeGreaterThan(estimateInputTokens('anthropic', noTools));
});

test('a tool-result carrying a large base64 image does not inflate the estimate', async () => {
  const bigBase64 = 'A'.repeat(20_000);
  const withMedia = {
    messages: [
      {
        role: 'tool' as const,
        content: [
          {
            type: 'tool-result' as const,
            toolCallId: 'call_1',
            toolName: 'render',
            output: {
              type: 'content' as const,
              value: [
                { type: 'text' as const, text: 'ok' },
                { type: 'media' as const, data: bigBase64, mediaType: 'image/png' },
              ],
            },
          },
        ],
      },
    ],
  };
  // The 20k base64 blob must not dominate: JSON.stringify(output) would be ~310 tokens.
  expect(estimateInputTokens('anthropic', withMedia)).toBeLessThan(50);
});

test('an assistant tool-call counts its name and input JSON', async () => {
  const bigInput = { query: 'x'.repeat(400), limit: 25, filters: ['a', 'b', 'c'] };
  const withCall = {
    messages: [
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'calling a tool' },
          { type: 'tool-call' as const, toolCallId: 'call_1', toolName: 'search', input: bigInput },
        ],
      },
    ],
  };
  const withoutCall = {
    messages: [{ role: 'assistant' as const, content: [{ type: 'text' as const, text: 'calling a tool' }] }],
  };
  expect(estimateInputTokens('anthropic', withCall)).toBeGreaterThan(estimateInputTokens('anthropic', withoutCall));
});

test('a long unbroken run scales with its length instead of collapsing to one token', async () => {
  const longRun = await invocationFrom({ messages: [{ role: 'user', content: 'a'.repeat(10_000) }] });
  const shortWord = await invocationFrom({ messages: [{ role: 'user', content: 'hello' }] });
  // 10k latin chars ~ 10000/5 = 2000 runs * ~1.13 tokens. A single collapsed token would be ~1.
  expect(estimateInputTokens('anthropic', longRun)).toBeGreaterThanOrEqual(1000);
  // A short word still rounds to ~1 token.
  expect(estimateInputTokens('anthropic', shortWord)).toBeLessThanOrEqual(3);
});
