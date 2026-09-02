import { expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { extractPassthroughObservation, extractPassthroughUsage } from '../../passthrough-usage';
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

test('retains a resumable Gemini Interaction owner from a body larger than two MiB', () => {
  const scan = createJsonUsageScan();
  scan.push(
    new TextEncoder().encode(
      JSON.stringify({
        id: 'intr_large',
        status: 'requires_action',
        padding: 'x'.repeat(2 * 1024 * 1024),
        usage: { total_input_tokens: 3, total_tokens: 3 },
      }),
    ),
  );
  scan.finish();

  expect(extractPassthroughObservation(ProviderProtocol.GeminiInteractions, scan.text() ?? '')).toMatchObject({
    responseId: 'intr_large',
  });
});

test('recovers after an over-cap top-level candidate value', () => {
  const scan = createJsonUsageScan();
  scan.push(
    new TextEncoder().encode(
      JSON.stringify({
        usage: 'x'.repeat(8 * 1024 - 1),
        id: 'intr_ok',
        status: 'requires_action',
        usageMetadata: { promptTokenCount: 3, totalTokenCount: 3 },
      }),
    ),
  );
  scan.finish();

  expect(extractPassthroughObservation(ProviderProtocol.GeminiInteractions, scan.text() ?? '')).toMatchObject({
    responseId: 'intr_ok',
  });
});

test('skips a huge unknown top-level key before retained fields', () => {
  const scan = createJsonUsageScan();
  scan.push(
    new TextEncoder().encode(
      JSON.stringify({
        ['x'.repeat(2 * 1024 * 1024)]: 'ignored',
        id: 'intr_ok',
        status: 'requires_action',
        usage: { total_input_tokens: 3, total_tokens: 3 },
      }),
    ),
  );
  scan.finish();

  expect(scan.text()).toBe(
    '{"id":"intr_ok","status":"requires_action","usage":{"total_input_tokens":3,"total_tokens":3}}',
  );
  expect(extractPassthroughObservation(ProviderProtocol.GeminiInteractions, scan.text() ?? '')).toMatchObject({
    responseId: 'intr_ok',
  });
});

test('recognizes escaped top-level candidate keys without retaining their raw spelling', () => {
  const scan = createJsonUsageScan();
  scan.push(
    new TextEncoder().encode(
      '{"\\u0069\\u0064":"intr_ok","\\u0073\\u0074\\u0061\\u0074\\u0075\\u0073":"requires_action","\\u0075\\u0073\\u0061\\u0067\\u0065":{"total_input_tokens":3,"total_tokens":3}}',
    ),
  );
  scan.finish();

  expect(scan.text()).toBe(
    '{"id":"intr_ok","status":"requires_action","usage":{"total_input_tokens":3,"total_tokens":3}}',
  );
  expect(extractPassthroughObservation(ProviderProtocol.GeminiInteractions, scan.text() ?? '')).toMatchObject({
    responseId: 'intr_ok',
    usage: { inputTokens: 3, totalTokens: 3 },
  });
});

test('recovers after a malformed unicode escape in a huge unknown top-level key', () => {
  const scan = createJsonUsageScan();
  scan.push(
    new TextEncoder().encode(
      `{"${'x'.repeat(2 * 1024 * 1024)}\\u000💩":"ignored","id":"intr_ok","status":"requires_action","usage":{"total_input_tokens":3,"total_tokens":3}}`,
    ),
  );
  scan.finish();

  expect(extractPassthroughObservation(ProviderProtocol.GeminiInteractions, scan.text() ?? '')).toMatchObject({
    responseId: 'intr_ok',
    usage: { inputTokens: 3, totalTokens: 3 },
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
