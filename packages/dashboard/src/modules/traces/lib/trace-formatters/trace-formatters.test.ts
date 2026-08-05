import { describe, expect, test } from '@rstest/core';

import { displayTotalTokens, formatTraceCost } from './trace-formatters';

describe('trace formatters', () => {
  test('prefers reported total tokens and only falls back to complete input/output pairs', () => {
    expect(displayTotalTokens({ providerId: 'p', modelId: 'm', totalTokens: 9, inputTokens: 3, outputTokens: 4 })).toBe(
      9,
    );
    expect(displayTotalTokens({ providerId: 'p', modelId: 'm', inputTokens: 3, outputTokens: 4 })).toBe(7);
    expect(displayTotalTokens({ providerId: 'p', modelId: 'm', inputTokens: 3 })).toBeUndefined();
    expect(displayTotalTokens(undefined)).toBeUndefined();
  });

  test('renders missing cost as an em dash', () => {
    expect(formatTraceCost(undefined, 'en-US')).toBe('—');
    expect(formatTraceCost(0.0049, 'en-US')).toBe('$0.0049');
  });
});
