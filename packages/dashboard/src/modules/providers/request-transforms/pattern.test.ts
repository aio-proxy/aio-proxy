import { describe, expect, test } from '@rstest/core';

import { patternToRegex, regexToPattern } from './pattern';

describe('Pattern codec', () => {
  test('uses a distinctive canonical regex wrapper', () => {
    expect(patternToRegex('gpt-*-mini')).toBe('^(?:gpt-.*-mini)$');
    expect(patternToRegex('a.b+$')).toBe('^(?:a\\.b\\+\\$)$');
  });

  test('recognizes only canonical Pattern regexes', () => {
    expect(regexToPattern('^(?:gpt-.*-mini)$')).toBe('gpt-*-mini');
    expect(regexToPattern('^gpt-.*$')).toBeUndefined();
  });
});
