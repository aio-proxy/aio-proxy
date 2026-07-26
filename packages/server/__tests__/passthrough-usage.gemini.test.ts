import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { extractPassthroughUsage } from '../src/passthrough-usage';

describe('passthrough usage extraction', () => {
  test('extracts Gemini JSON usage metadata', () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.Gemini,
        JSON.stringify({
          usageMetadata: {
            promptTokenCount: 17,
            candidatesTokenCount: 19,
            totalTokenCount: 36,
          },
        }),
      ),
    ).toEqual({
      inputTokens: 17,
      outputTokens: 19,
      totalTokens: 36,
    });
  });

  test('extracts the last Gemini streamGenerateContent JSON usage metadata', () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.Gemini,
        JSON.stringify([
          {
            usageMetadata: {
              promptTokenCount: 3,
              candidatesTokenCount: 4,
              totalTokenCount: 7,
            },
          },
          { candidates: [] },
          {
            usageMetadata: {
              promptTokenCount: 17,
              candidatesTokenCount: 19,
              totalTokenCount: 36,
              cachedContentTokenCount: 7,
              thoughtsTokenCount: 5,
            },
          },
        ]),
      ),
    ).toEqual({
      inputTokens: 17,
      outputTokens: 19,
      totalTokens: 36,
      cacheReadTokens: 7,
      reasoningTokens: 5,
    });
  });

  test('ignores Gemini streamGenerateContent JSON without usage metadata', () => {
    expect(extractPassthroughUsage(ProviderProtocol.Gemini, JSON.stringify([]))).toBeUndefined();
    expect(
      extractPassthroughUsage(ProviderProtocol.Gemini, JSON.stringify([{ candidates: [] }, { usageMetadata: {} }])),
    ).toBeUndefined();
  });

  test('preserves Gemini cache and reasoning dimensions', () => {
    expect(
      extractPassthroughUsage(
        ProviderProtocol.Gemini,
        JSON.stringify({
          usageMetadata: {
            promptTokenCount: 17,
            candidatesTokenCount: 19,
            totalTokenCount: 36,
            cachedContentTokenCount: 7,
            thoughtsTokenCount: 5,
          },
        }),
      ),
    ).toEqual({
      inputTokens: 17,
      outputTokens: 19,
      totalTokens: 36,
      cacheReadTokens: 7,
      reasoningTokens: 5,
    });
  });
});
