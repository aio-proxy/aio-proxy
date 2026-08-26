import { expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { extractPassthroughUsage } from '../../passthrough-usage';
import { createJsonUsageScan } from './json-usage-scan';

test('captures a trailing usage object split across UTF-8 chunks', () => {
  const body = new TextEncoder().encode(
    JSON.stringify({
      padding: '🙂'.repeat(8),
      usage: { prompt_tokens: 3, total_tokens: 3 },
    }),
  );
  const scan = createJsonUsageScan();
  const split = body.indexOf(0xf0) + 2;
  scan.push(body.subarray(0, split));
  scan.push(body.subarray(split));
  scan.finish();
  expect(scan.text()).toBe('{"usage":{"prompt_tokens":3,"total_tokens":3}}');
  expect(extractPassthroughUsage(ProviderProtocol.OpenAICompatible, scan.text() ?? '')).toEqual({
    inputTokens: 3,
    totalTokens: 3,
  });
});

test('extracts usage from a body larger than the passthrough JSON cap', () => {
  const scan = createJsonUsageScan();
  scan.push(
    new TextEncoder().encode(
      JSON.stringify({
        padding: 'x'.repeat(2 * 1024 * 1024),
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    ),
  );
  scan.finish();
  expect(extractPassthroughUsage(ProviderProtocol.OpenAICompatible, scan.text() ?? '')).toEqual({
    inputTokens: 3,
    outputTokens: 2,
    totalTokens: 5,
  });
});

test('extracts leading usage before a large embeddings payload', () => {
  const scan = createJsonUsageScan();
  scan.push(
    new TextEncoder().encode(
      JSON.stringify({
        usage: { prompt_tokens: 8, total_tokens: 8 },
        data: [{ embedding: Array.from({ length: 256 * 1024 }, () => 0.1) }],
      }),
    ),
  );
  scan.finish();
  expect(extractPassthroughUsage(ProviderProtocol.OpenAICompatible, scan.text() ?? '')).toEqual({
    inputTokens: 8,
    totalTokens: 8,
  });
});

test('ignores nested usage and keeps the top-level usageMetadata object', () => {
  const scan = createJsonUsageScan();
  scan.push(
    new TextEncoder().encode(
      JSON.stringify({
        embeddings: [{ usage: { prompt_tokens: 99 } }],
        usageMetadata: { promptTokenCount: 8 },
      }),
    ),
  );
  scan.finish();
  expect(scan.text()).toBe('{"usageMetadata":{"promptTokenCount":8}}');
  expect(extractPassthroughUsage(ProviderProtocol.Gemini, scan.text() ?? '')).toEqual({
    inputTokens: 8,
  });
});
