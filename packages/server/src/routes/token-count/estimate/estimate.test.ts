import { expect, test } from 'bun:test';

import { anthropicMessagesAdapter } from '@aio-proxy/core';

import { estimateInputTokens } from './estimate';

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

test('an image part contributes a fixed surcharge regardless of base64 size', async () => {
  const small = await invocationFrom({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(20_000) } },
        ],
      },
    ],
  });
  const large = await invocationFrom({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(200_000) } },
        ],
      },
    ],
  });
  const textOnly = await invocationFrom({ messages: [{ role: 'user', content: 'describe this' }] });
  // The image adds a flat surcharge, not a byte-scaled count: both sizes estimate identically.
  expect(estimateInputTokens('anthropic', small)).toBe(estimateInputTokens('anthropic', large));
  // And it is the text estimate plus the fixed image surcharge (~1600), never ~1.
  expect(estimateInputTokens('anthropic', small)).toBeGreaterThanOrEqual(1600);
  expect(estimateInputTokens('anthropic', small)).toBeGreaterThan(estimateInputTokens('anthropic', textOnly));
});

test('an image-only user message estimates the image surcharge, not ~1 token', async () => {
  const imageOnly = await invocationFrom({
    messages: [
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] },
    ],
  });
  expect(estimateInputTokens('anthropic', imageOnly)).toBeGreaterThanOrEqual(1600);
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

test('a tool-result image surcharges a fixed amount regardless of base64 size', async () => {
  const small = {
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
                { type: 'media' as const, data: 'A'.repeat(20_000), mediaType: 'image/png' },
              ],
            },
          },
        ],
      },
    ],
  };
  const large = {
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
                { type: 'media' as const, data: 'A'.repeat(200_000), mediaType: 'image/png' },
              ],
            },
          },
        ],
      },
    ],
  };
  // The base64 blob is never byte-counted: both sizes estimate the same fixed image surcharge.
  expect(estimateInputTokens('anthropic', small)).toBe(estimateInputTokens('anthropic', large));
  expect(estimateInputTokens('anthropic', small)).toBeGreaterThanOrEqual(1600);
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

test('a non-image file (PDF) part estimates at least the file surcharge', async () => {
  const withPdf = {
    messages: [
      {
        role: 'user' as const,
        content: [
          { type: 'file' as const, mediaType: 'application/pdf', data: { type: 'data' as const, data: 'JVBER=' } },
        ],
      },
    ],
  };
  expect(estimateInputTokens('anthropic', withPdf)).toBeGreaterThanOrEqual(2000);
});
